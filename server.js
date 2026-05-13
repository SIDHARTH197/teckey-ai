const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('./')); // Serve frontend files directly from this server

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error. Please ensure MONGODB_URI in .env is correct:', err));

// Mongoose Schema
const messageSchema = new mongoose.Schema({
  role: String,
  content: String
});

const conversationSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  messages: [messageSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Conversation = mongoose.model('Conversation', conversationSchema);

// Initial System Prompt
const SYSTEM_PROMPT = {
  role: 'system',
  content: 'You are an intelligent, helpful, and concise AI customer support assistant for Teckey. Teckey provides digital marketing, web development, and an advanced e-commerce analytics dashboard. Keep your answers clear, professional, and directly address the user\'s needs.'
};

// API Route to handle chat messages
app.post('/api/chat', async (req, res) => {
  const { sessionId, message } = req.body;

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'sessionId and message are required' });
  }

  try {
    // 1. Find or create conversation in MongoDB
    let conversation = await Conversation.findOne({ sessionId });

    if (!conversation) {
      conversation = new Conversation({
        sessionId,
        messages: [SYSTEM_PROMPT]
      });
    }

    // 2. Add user message
    const userMsg = { role: 'user', content: message };
    conversation.messages.push(userMsg);

    // 3. Hybrid Memory System (Keyword Search + Sliding Window)
    const MAX_HISTORY = 10;

    // Stop words to ignore during keyword extraction
    const stopWords = new Set(['the', 'is', 'at', 'which', 'and', 'on', 'a', 'an', 'in', 'of', 'to', 'for', 'with', 'what', 'where', 'when', 'how', 'why', 'who', 'my', 'i', 'am', 'are', 'you', 'your', 'it', 'this', 'that']);

    // Extract keywords from the new message
    const words = message.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
    const keywords = words.filter(word => word.length > 2 && !stopWords.has(word));

    // Grab the system prompt
    const systemPromptMsg = {
      role: conversation.messages[0].role,
      content: conversation.messages[0].content
    };

    // Separate the recent window from the old history
    const allPastMessages = conversation.messages.slice(1, -1); // exclude system prompt and the current message

    const recentWindowStartIndex = Math.max(0, allPastMessages.length - MAX_HISTORY);
    const oldHistory = allPastMessages.slice(0, recentWindowStartIndex);
    const recentMessages = allPastMessages.slice(recentWindowStartIndex);

    // Search old history for keywords
    let recalledMemories = [];
    if (keywords.length > 0 && oldHistory.length > 0) {
      for (let i = 0; i < oldHistory.length; i++) {
        const oldMsg = oldHistory[i];
        if (oldMsg.role === 'user') {
          const oldContent = oldMsg.content.toLowerCase();
          const matchCount = keywords.filter(kw => oldContent.includes(kw)).length;

          if (matchCount > 0) {
            // Found a match! Get the bot's response to it as well
            const botReply = (i + 1 < oldHistory.length && oldHistory[i + 1].role === 'assistant') ? oldHistory[i + 1].content : 'No reply recorded.';

            recalledMemories.push({
              role: 'system',
              content: `[RECALLED MEMORY FROM PAST] The user previously said: "${oldMsg.content}". You replied: "${botReply}"`
            });
          }
        }
      }
    }

    // Limit recalled memories to the 3 most recent matches to save tokens
    if (recalledMemories.length > 3) {
      recalledMemories = recalledMemories.slice(-3);
    }

    // Assemble the final payload
    const messagesForGroq = [
      systemPromptMsg,
      ...recalledMemories,
      ...recentMessages.map(msg => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: message } // The new message
    ];

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: messagesForGroq,
        temperature: 0.7,
        max_tokens: 1024
      })
    });

    if (!response.ok) {
      throw new Error(`Groq API Error: ${response.status}`);
    }

    const data = await response.json();
    const botResponseContent = data.choices[0].message.content;

    // 4. Add bot response to conversation
    const botMsg = { role: 'assistant', content: botResponseContent };
    conversation.messages.push(botMsg);
    conversation.updatedAt = Date.now();

    // 5. Save to MongoDB
    await conversation.save();

    // 6. Return response to frontend
    res.json({ reply: botResponseContent });

  } catch (error) {
    console.error('Error in /api/chat:', error);
    res.status(500).json({ error: 'Failed to process chat message' });
  }
});

// API Route to load history
app.get('/api/history/:sessionId', async (req, res) => {
  try {
    const conversation = await Conversation.findOne({ sessionId: req.params.sessionId });
    if (conversation) {
      // Filter out the system prompt before sending to frontend
      const historyToReturn = conversation.messages.filter(msg => msg.role !== 'system');
      res.json(historyToReturn);
    } else {
      res.json([]);
    }
  } catch (error) {
    console.error('Error in /api/history:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
