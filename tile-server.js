import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors({
  allowedHeaders: ['Range', 'If-Match'],
  exposedHeaders: ['ETag', 'Content-Range', 'Content-Length'],
}));
app.use(express.static('data'));
app.listen(9000, () => console.log('Tile server on http://localhost:9000'));