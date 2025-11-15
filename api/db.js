// api/db.js
import mongoose from "mongoose";

const URI = process.env.MONGODB_URI;
if (!URI) throw new Error("MONGODB_URI não definida!");

let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

export default async function connectDB() {
  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    cached.promise = mongoose.connect(URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
  }

  cached.conn = await cached.promise;
  console.log("🟢 Conectado ao MongoDB via Mongoose");
  return cached.conn;
}