// index.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config(); // .envファイルから環境変数を読み込む

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// 環境変数からMongoDBの接続URIを取得
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/instant-chat';

// MongoDBに接続
mongoose.connect(MONGODB_URI)
.then(() => console.log('MongoDBに接続しました'))
.catch(err => console.error('MongoDB接続エラー:', err));

// メッセージスキーマの定義
const messageSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, index: true },
  sender: { type: String, required: true },
  content: { type: String }, // テキストメッセージの場合
  audio: { type: String }, // Base64エンコードされた音声データの場合
  type: { type: String, enum: ['text', 'audio'], required: true },
  timestamp: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', messageSchema);

// 静的ファイルの提供
app.use(express.static(path.join(__dirname, 'public')));

// ルートエンドポイント
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// セッション管理用オブジェクト
const sessions = {};

// UUIDを使ったセッション生成エンドポイント
app.get('/create', (req, res) => {
  const sessionId = uuidv4();
  // セッションを初期化
  sessions[sessionId] = { 
    destroyed: false, 
    participants: new Set(), 
    nicknames: {} 
  };
  res.redirect(`/${sessionId}`);
});

// セッションIDに基づくチャットページの提供
app.get('/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  if (sessions[sessionId] && !sessions[sessionId].destroyed) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  }
});

// QRコード生成エンドポイント
app.get('/qrcode/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  if (sessions[sessionId] && !sessions[sessionId].destroyed) {
    const url = `${req.protocol}://${req.get('host')}/${sessionId}`;
    try {
      const qrDataUrl = await QRCode.toDataURL(url);
      res.json({ qrCode: qrDataUrl });
    } catch (err) {
      console.error('QRコード生成エラー:', err);
      res.status(500).send('QRコード生成エラー');
    }
  } else {
    res.status(404).json({ error: 'セッションが存在しないか、破棄されています。' });
  }
});

// Socket.IOの接続処理
io.on('connection', (socket) => {
  console.log('新しいクライアントが接続しました');

  // ルームに参加
  socket.on('join room', async (room) => {
    if (sessions[room] && !sessions[room].destroyed) {
      socket.join(room);
      sessions[room].participants.add(socket.id);
      console.log(`クライアントがルーム ${room} に参加しました`);

      // チャット履歴をデータベースから取得
      try {
        const history = await Message.find({ sessionId: room }).sort({ timestamp: 1 }).exec();
        socket.emit('chat history', history);
      } catch (err) {
        console.error('チャット履歴取得エラー:', err);
        socket.emit('error message', 'チャット履歴の取得に失敗しました。');
      }
    } else {
      socket.emit('error message', 'セッションが存在しないか、破棄されています。');
    }
  });

  // ニックネームの設定
  socket.on('set nickname', ({ sessionId, nickname }) => {
    if (sessions[sessionId] && !sessions[sessionId].destroyed) {
      sessions[sessionId].nicknames[socket.id] = nickname;
      console.log(`クライアント ${socket.id} のニックネームを ${nickname} に設定しました`);
    }
  });

  // チャットメッセージの受信と保存・ブロードキャスト
  socket.on('chat message', async ({ sessionId, message }) => {
    const room = sessionId;
    if (sessions[room] && !sessions[room].destroyed) {
      const sender = sessions[room].nicknames[socket.id] || '匿名';
      const msgObj = {
        sessionId: room,
        sender: sender,
        content: message,
        type: 'text',
      };
      try {
        // メッセージをデータベースに保存
        const msg = new Message(msgObj);
        await msg.save();

        // ブロードキャスト
        io.to(room).emit('chat message', msgObj);
      } catch (err) {
        console.error('チャットメッセージ保存エラー:', err);
        socket.emit('error message', 'メッセージの送信に失敗しました。');
      }
    }
  });

  // 音声メッセージの受信と保存・ブロードキャスト
  socket.on('audio message', async ({ sessionId, nickname, audio }) => {
    const room = sessionId;
    if (sessions[room] && !sessions[room].destroyed) {
      const sender = nickname || sessions[room].nicknames[socket.id] || '匿名';
      const msgObj = {
        sessionId: room,
        sender: sender,
        audio: audio, // Base64エンコードされた音声データ
        type: 'audio',
      };
      try {
        // 音声メッセージをデータベースに保存
        const msg = new Message(msgObj);
        await msg.save();

        // ブロードキャスト
        io.to(room).emit('audio message', msgObj);
      } catch (err) {
        console.error('音声メッセージ保存エラー:', err);
        socket.emit('error message', '音声メッセージの送信に失敗しました。');
      }
    }
  });

  // チャット破棄の受信
  socket.on('destroy chat', async (room) => {
    if (sessions[room] && !sessions[room].destroyed) {
      sessions[room].destroyed = true;

      try {
        // データベースからチャット履歴を削除
        await Message.deleteMany({ sessionId: room });

        // ルーム内の全クライアントに通知
        io.to(room).emit('chat destroyed');

        // ルーム内の全クライアントを取得
        const clients = await io.in(room).allSockets();
        clients.forEach((clientId) => {
          const clientSocket = io.sockets.sockets.get(clientId);
          if (clientSocket) {
            clientSocket.leave(room);
            // ニックネームの削除
            delete sessions[room].nicknames[clientId];
          }
        });

        // セッションを削除
        delete sessions[room];
        console.log(`セッション ${room} を破棄しました`);
      } catch (err) {
        console.error('チャット破棄エラー:', err);
        socket.emit('error message', 'チャットの破棄に失敗しました。');
      }
    }
  });

  // 切断時の処理
  socket.on('disconnect', () => {
    console.log('クライアントが切断しました');
    // 各セッションからクライアントを削除
    for (const room in sessions) {
      if (sessions[room].participants.has(socket.id)) {
        sessions[room].participants.delete(socket.id);
        // ニックネームも削除
        delete sessions[room].nicknames[socket.id];
      }
    }
  });
});

// サーバーの起動
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`サーバーがポート ${PORT} で起動しました`);
});
