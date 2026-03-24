import { StreamChat } from "stream-chat";
import dotenv from "dotenv";
dotenv.config();

export const serverClient = StreamChat.getInstance(
  process.env.STREAM_API_KEY || process.env.STREAM_CHAT_API_KEY,
  process.env.STREAM_API_SECRET || process.env.STREAM_CHAT_API_SECRET
);
