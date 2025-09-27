import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// 👉 Needed for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Serve index.html when visiting "/"
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ✅ Build Azure OpenAI URL
const apiUrl = `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${process.env.AZURE_OPENAI_API_VERSION}`;

app.post("/chat", async (req, res) => {
  try {
    console.log("👉 Incoming message:", req.body.message);

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": process.env.AZURE_OPENAI_API_KEY,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: req.body.message }],
        max_tokens: 200,
      }),
    });

    const data = await response.json();

    console.log("🔵 Azure response:", JSON.stringify(data, null, 2));

    res.json({
      reply: data.choices?.[0]?.message?.content || "⚠️ No reply from Azure OpenAI",
    });
  } catch (error) {
    console.error("❌ Chat error:", error);
    res.status(500).send("Something went wrong");
  }
});

app.listen(3000, () => {
  console.log("✅ Server listening on http://localhost:3000");
});
