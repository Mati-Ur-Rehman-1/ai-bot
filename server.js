import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fileUpload from "express-fileupload";

dotenv.config();

// Check required environment variables
const requiredEnvVars = [
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_DEPLOYMENT',
  'AZURE_VISION_ENDPOINT',
  'AZURE_VISION_KEY',
  'AZURE_TRANSLATOR_KEY',
  'AZURE_REGION',
  'AZURE_OPENAI_IMAGE_ENDPOINT',
  'AZURE_OPENAI_IMAGE_KEY',
  'AZURE_OPENAI_IMAGE_DEPLOYMENT'
];

const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingEnvVars);
  console.error('Please check your .env file');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(fileUpload());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Serve frontend
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ✅ Chatbot (GPT)
const chatApiUrl = `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${process.env.AZURE_OPENAI_API_VERSION}`;

app.post("/chat", async (req, res) => {
  try {
    const response = await fetch(chatApiUrl, {
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
      reply: data.choices?.[0]?.message?.content || "⚠️ No reply from Azure OpenAI",
    });
  } catch (error) {
    console.error("❌ Chat error:", error);
    res.status(500).send("Something went wrong");
  }
});

// ✅ FIXED OCR + Translation
app.post("/ocr", async (req, res) => {
  try {
    console.log("📸 OCR Request received");
    
    if (!req.files || !req.files.image) {
      console.log("❌ No file uploaded");
      return res.status(400).json({ error: "No file uploaded" });
    }

    const imageFile = req.files.image;
    const targetLang = req.body.lang || "en";
    
    console.log(`🔧 Image details: ${imageFile.name}, Size: ${imageFile.size}, Language: ${targetLang}`);

    // ✅ FIXED: Use correct environment variables
    const visionEndpoint = process.env.AZURE_VISION_ENDPOINT;
    const visionKey = process.env.AZURE_VISION_KEY;

    if (!visionEndpoint || !visionKey) {
      throw new Error("Azure Vision credentials not configured");
    }

    // ✅ FIXED: Correct OCR API URL construction
    const ocrUrl = `${visionEndpoint.replace(/\/$/, '')}/vision/v3.2/read/analyze`;
    
    const ocrResponse = await fetch(ocrUrl, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": visionKey,
        "Content-Type": "application/octet-stream",
      },
      body: imageFile.data,
    });

    console.log(`🔧 OCR Response Status: ${ocrResponse.status}`);

    if (!ocrResponse.ok) {
      const errorText = await ocrResponse.text();
      console.error("❌ OCR API Error:", errorText);
      throw new Error(`OCR request failed: ${ocrResponse.status} ${errorText}`);
    }

    const operationLocation = ocrResponse.headers.get("operation-location");
    console.log(`🔧 Operation Location: ${operationLocation}`);

    if (!operationLocation) {
      throw new Error("No operation-location in OCR response");
    }

    // ✅ Improved polling with timeout
    let result;
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const pollResponse = await fetch(operationLocation, {
        headers: { 
          "Ocp-Apim-Subscription-Key": visionKey 
        },
      });

      if (!pollResponse.ok) {
        throw new Error(`Polling failed: ${pollResponse.status}`);
      }

      result = await pollResponse.json();
      console.log(`🔧 Polling attempt ${attempts + 1}: ${result.status}`);

      if (result.status === "succeeded") {
        break;
      } else if (result.status === "failed") {
        throw new Error("OCR processing failed");
      }

      attempts++;
    }

    if (result.status !== "succeeded") {
      throw new Error("OCR did not complete in time");
    }

    // ✅ Extract text from result
    let extractedText = "";
    if (result.analyzeResult && result.analyzeResult.readResults) {
      extractedText = result.analyzeResult.readResults
        .map(page => page.lines.map(line => line.text).join("\n"))
        .join("\n");
    }

    console.log(`📝 Extracted Text: ${extractedText.substring(0, 100)}...`);

    // ✅ Translation only if text was extracted
    let translatedText = "No text to translate";
    
    if (extractedText && extractedText.trim() !== "") {
      try {
        const translatorKey = process.env.AZURE_TRANSLATOR_KEY;
        const translatorRegion = process.env.AZURE_REGION;

        if (!translatorKey || !translatorRegion) {
          throw new Error("Translation credentials not configured");
        }

        const transResponse = await fetch(
          `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${targetLang}`,
          {
            method: "POST",
            headers: {
              "Ocp-Apim-Subscription-Key": translatorKey,
              "Ocp-Apim-Subscription-Region": translatorRegion,
              "Content-Type": "application/json",
            },
            body: JSON.stringify([{ Text: extractedText }]),
          }
        );

        if (!transResponse.ok) {
          throw new Error(`Translation failed: ${transResponse.status}`);
        }

        const transData = await transResponse.json();
        translatedText = transData[0]?.translations?.[0]?.text || "Translation failed";
        
        console.log(`🌍 Translated Text: ${translatedText.substring(0, 100)}...`);
      } catch (transError) {
        console.error("❌ Translation error:", transError);
        translatedText = "Translation service unavailable";
      }
    }

    res.json({ 
      extractedText: extractedText || "No text found in image", 
      translatedText 
    });

  } catch (error) {
    console.error("❌ OCR/Translation error:", error.message);
    res.status(500).json({ 
      error: error.message,
      extractedText: "OCR processing failed",
      translatedText: "Translation failed" 
    });
  }
});

// ✅ Image Generation (DALL·E)
app.post("/generate-image", async (req, res) => {
  try {
    const prompt = req.body.prompt;
    console.log(`🎨 Generating image for prompt: ${prompt}`);

    const response = await fetch(
      `${process.env.AZURE_OPENAI_IMAGE_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT}/images/generations?api-version=${process.env.AZURE_OPENAI_IMAGE_API_VERSION}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": process.env.AZURE_OPENAI_IMAGE_KEY,
        },
        body: JSON.stringify({
          prompt,
          size: "1024x1024",
          n: 1
        }),
      }
    );

    const data = await response.json();
    console.log("🔍 Image API Response:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      throw new Error(`Image generation failed: ${response.status} ${JSON.stringify(data)}`);
    }

    const imageUrl = data.data?.[0]?.url;
    if (!imageUrl) {
      throw new Error("No image URL in response");
    }

    res.json({ imageUrl });
  } catch (error) {
    console.error("❌ Image generation error:", error);
    res.status(500).json({ error: "Image generation failed: " + error.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));
