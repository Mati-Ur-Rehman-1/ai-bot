import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fileUpload from "express-fileupload";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(fileUpload());

// 👉 Needed for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Serve index.html when visiting "/"
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ✅ Azure OpenAI URL (Chatbot)
const apiUrl = `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${process.env.AZURE_OPENAI_API_VERSION}`;

// ✅ Chat route
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
    res.json({
      reply:
        data.choices?.[0]?.message?.content ||
        "⚠️ No reply from Azure OpenAI",
    });
  } catch (error) {
    console.error("❌ Chat error:", error);
    res.status(500).send("Something went wrong");
  }
});

// ✅ OCR + Translation route (using Read API)
app.post("/ocr", async (req, res) => {
  try {
    console.log("📌 OCR request received...");

    if (!req.files || !req.files.image) {
      return res.status(400).send("No file uploaded");
    }

    const imageBuffer = req.files.image.data;
    const targetLang = req.body.lang || "en"; // 👈 default English

    // 1. Send OCR request (Read API)
    const ocrResponse = await fetch(
      `${process.env.AZURE_ENDPOINT}/vision/v3.2/read/analyze`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": process.env.AZURE_KEY,
          "Content-Type": "application/octet-stream",
        },
        body: imageBuffer,
      }
    );

    if (!ocrResponse.ok) {
      throw new Error("OCR request failed");
    }

    // Get operation-location (polling URL)
    const operationLocation = ocrResponse.headers.get("operation-location");
    if (!operationLocation) {
      throw new Error("No operation-location in OCR response");
    }

    // 2. Poll for result
    let result;
    for (let i = 0; i < 10; i++) {
      const pollResponse = await fetch(operationLocation, {
        headers: { "Ocp-Apim-Subscription-Key": process.env.AZURE_KEY },
      });
      result = await pollResponse.json();

      if (result.status === "succeeded") break;
      await new Promise((r) => setTimeout(r, 1000)); // wait 1 sec
    }

    if (result.status !== "succeeded") {
      throw new Error("OCR did not succeed in time");
    }

    // 3. Extract text
    const extractedText = result.analyzeResult.readResults
      .map((page) => page.lines.map((l) => l.text).join("\n"))
      .join("\n");

    console.log("📝 Extracted Text:", extractedText);

    // 4. Translator request
    const transResponse = await fetch(
      `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${targetLang}`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": process.env.AZURE_KEY,
          "Ocp-Apim-Subscription-Region": process.env.AZURE_REGION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([{ Text: extractedText }]),
      }
    );

    const transData = await transResponse.json();
    console.log("✅ Translator Raw Response:", JSON.stringify(transData, null, 2));

    const translatedText =
      transData[0]?.translations?.[0]?.text || "⚠️ Translation failed";

    res.json({ extractedText, translatedText });
  } catch (error) {
    console.error("❌ OCR/Translation error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});
