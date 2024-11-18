import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import dotenv from "dotenv";
import bodyParser from "body-parser";

// Load environment variables
dotenv.config();

// Retrieve OpenAI API key
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1);
}

// Initialize Express and HTTP server
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Constants
const SYSTEM_MESSAGE =
  "You are a helpful and bubbly AI assistant who loves to chat about anything the user is interested about and is prepared to offer them facts. You have a penchant for dad jokes, owl jokes, and rickrolling – subtly. Always stay positive, but work in a joke when appropriate.";
const VOICE = "alloy";
const PORT = process.env.PORT || 5050;

// Event types to log
const LOG_EVENT_TYPES = [
  "error",
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
];

const SHOW_TIMING_MATH = false;

// Root route
app.get("/", (req, res) => {
  res.json({ message: "Twilio Media Stream Server is running!" });
});

// Twilio incoming call route
app.all("/incoming-call", (req, res) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>Please wait while we connect your call to the A. I. voice assistant, powered by Twilio and the Open-A.I. Realtime API</Say>
                              <Pause length="1"/>
                              <Say>O.K. you can start talking!</Say>
                              <Connect>
                                  <Stream url="wss://${req.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

  res.set("Content-Type", "text/xml");
  res.send(twimlResponse);
});

// WebSocket connection handler
wss.on("connection", (ws, req) => {
  if (req.url !== "/media-stream") {
    ws.close();
    return;
  }

  console.log("Client connected");

  // Connection-specific state
  let streamSid = null;
  let latestMediaTimestamp = 0;
  let lastAssistantItem = null;
  let markQueue = [];
  let responseStartTimestampTwilio = null;

  const openAiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // Initialize session with OpenAI
  const initializeSession = () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad" },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: VOICE,
        instructions: SYSTEM_MESSAGE,
        modalities: ["text", "audio"],
        temperature: 0.8,
      },
    };

    console.log("Sending session update:", JSON.stringify(sessionUpdate));
    openAiWs.send(JSON.stringify(sessionUpdate));
  };

  // Initial conversation handler
  const sendInitialConversationItem = () => {
    const initialConversationItem = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: 'Greet the user with "Hello there! I am an AI voice assistant powered by Twilio and the OpenAI Realtime API. You can ask me for facts, jokes, or anything you can imagine. How can I help you?"',
          },
        ],
      },
    };

    if (SHOW_TIMING_MATH)
      console.log(
        "Sending initial conversation item:",
        JSON.stringify(initialConversationItem)
      );
    openAiWs.send(JSON.stringify(initialConversationItem));
    openAiWs.send(JSON.stringify({ type: "response.create" }));
  };

  // Handle speech interruption
  const handleSpeechStartedEvent = () => {
    if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
      const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
      if (SHOW_TIMING_MATH)
        console.log(
          `Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`
        );

      if (lastAssistantItem) {
        const truncateEvent = {
          type: "conversation.item.truncate",
          item_id: lastAssistantItem,
          content_index: 0,
          audio_end_ms: elapsedTime,
        };
        if (SHOW_TIMING_MATH)
          console.log(
            "Sending truncation event:",
            JSON.stringify(truncateEvent)
          );
        openAiWs.send(JSON.stringify(truncateEvent));
      }

      ws.send(
        JSON.stringify({
          event: "clear",
          streamSid: streamSid,
        })
      );

      // Reset state
      markQueue = [];
      lastAssistantItem = null;
      responseStartTimestampTwilio = null;
    }
  };

  // Send mark messages
  const sendMark = (ws, streamSid) => {
    if (streamSid) {
      const markEvent = {
        event: "mark",
        streamSid: streamSid,
        mark: { name: "responsePart" },
      };
      ws.send(JSON.stringify(markEvent));
      markQueue.push("responsePart");
    }
  };

  // OpenAI WebSocket event handlers
  openAiWs.on("open", () => {
    console.log("Connected to the OpenAI Realtime API");
    setTimeout(initializeSession, 100);
  });

  openAiWs.on("message", (data) => {
    try {
      const response = JSON.parse(data);

      if (LOG_EVENT_TYPES.includes(response.type)) {
        console.log(`Received event: ${response.type}`, response);
      }

      if (response.type === "response.audio.delta" && response.delta) {
        const audioDelta = {
          event: "media",
          streamSid: streamSid,
          media: {
            payload: Buffer.from(response.delta, "base64").toString("base64"),
          },
        };
        ws.send(JSON.stringify(audioDelta));

        if (!responseStartTimestampTwilio) {
          responseStartTimestampTwilio = latestMediaTimestamp;
          if (SHOW_TIMING_MATH)
            console.log(
              `Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`
            );
        }

        if (response.item_id) {
          lastAssistantItem = response.item_id;
        }

        sendMark(ws, streamSid);
      }

      if (response.type === "input_audio_buffer.speech_started") {
        handleSpeechStartedEvent();
      }
    } catch (error) {
      console.error(
        "Error processing OpenAI message:",
        error,
        "Raw message:",
        data
      );
    }
  });

  // Handle incoming WebSocket messages from Twilio
  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.event) {
        case "media":
          latestMediaTimestamp = data.media.timestamp;
          if (SHOW_TIMING_MATH)
            console.log(
              `Received media message with timestamp: ${latestMediaTimestamp}ms`
            );
          if (openAiWs.readyState === WebSocket.OPEN) {
            const audioAppend = {
              type: "input_audio_buffer.append",
              audio: data.media.payload,
            };
            openAiWs.send(JSON.stringify(audioAppend));
          }
          break;
        case "start":
          streamSid = data.start.streamSid;
          console.log("Incoming stream has started", streamSid);
          responseStartTimestampTwilio = null;
          latestMediaTimestamp = 0;
          break;
        case "mark":
          if (markQueue.length > 0) {
            markQueue.shift();
          }
          break;
        default:
          console.log("Received non-media event:", data.event);
          break;
      }
    } catch (error) {
      console.error("Error parsing message:", error, "Message:", message);
    }
  });

  // Handle connection close
  ws.on("close", () => {
    if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    console.log("Client disconnected.");
  });

  // Handle OpenAI WebSocket events
  openAiWs.on("close", () => {
    console.log("Disconnected from the OpenAI Realtime API");
  });

  openAiWs.on("error", (error) => {
    console.error("Error in the OpenAI WebSocket:", error);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
