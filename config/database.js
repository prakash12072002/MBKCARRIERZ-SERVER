import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

console.log('Attempting to connect to MongoDB with URI:', process.env.MONGO_URI ? 'URI DEFINED' : 'URI UNDEFINED');

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected successfully"))
  .catch((err) => console.error("MongoDB connection error:", err));

export default mongoose;
