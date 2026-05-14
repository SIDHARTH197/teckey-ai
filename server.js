const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configure Multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, './')));

// Fallback to serve index.html for any unknown routes (important for SPAs and clean URLs)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error. Please ensure MONGODB_URI in .env is correct:', err));

// Mongoose Schemas
const knowledgeSchema = new mongoose.Schema({
  topic: { type: String, required: true },
  content: { type: String, required: true },
  addedAt: { type: Date, default: Date.now }
});

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
const Knowledge = mongoose.model('Knowledge', knowledgeSchema);

// Initial System Prompt
const SYSTEM_PROMPT = {
  role: 'system',
  content: 'You are an intelligent, helpful, and concise AI customer support assistant for Teckey. Teckey provides digital marketing, web development, and an advanced e-commerce analytics dashboard. Use the provided [FACTS] to answer accurately. If you don\'t know something, say so.'
};

// Admin Route to Upload Documents (PDF/DOCX)
app.post('/api/admin/upload', upload.single('file'), async (req, res) => {
  const { adminKey } = req.body;
  const validAdmin = !!(adminKey && process.env.ADMIN_SECRET_KEY && adminKey === process.env.ADMIN_SECRET_KEY);

  if (!validAdmin) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(401).json({ error: 'Unauthorized: Invalid Admin Key' });
  }

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    let extractedText = '';
    const filePath = req.file.path;

    if (req.file.mimetype === 'application/pdf') {
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdf(dataBuffer);
      extractedText = data.text;
    } else if (req.file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await mammoth.extractRawText({ path: filePath });
      extractedText = result.value;
    } else {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Unsupported file type. Use PDF or DOCX.' });
    }

    const newKnowledge = new Knowledge({
      topic: `File: ${req.file.originalname}`,
      content: extractedText.trim()
    });
    await newKnowledge.save();
    fs.unlinkSync(filePath);
    res.json({ message: `Successfully processed and learned from ${req.file.originalname}` });
  } catch (error) {
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Failed to process document' });
  }
});

// API Route for Admin to "feed" data manually
app.post('/api/admin/feed', async (req, res) => {
  const { adminKey, topic, content } = req.body;
  const validAdmin = !!(adminKey && process.env.ADMIN_SECRET_KEY && adminKey === process.env.ADMIN_SECRET_KEY);

  if (!validAdmin) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Admin Key' });
  }

  try {
    const newKnowledge = new Knowledge({ topic, content });
    await newKnowledge.save();
    res.json({ message: 'Knowledge added successfully!' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save knowledge' });
  }
});

/**
 * Searches for relevant facts across Knowledge and all Conversations
 * This is the core of our Hybrid RAG system.
 */
async function getRelevantContext(userQuery, isAdmin) {
  try {
    const keywords = userQuery.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 3);

    if (keywords.length === 0) return "";

    const regexQueries = keywords.map(kw => new RegExp(kw, 'i'));

    // 1. Search Knowledge Collection (ALWAYS available to everyone)
    const knowledgeDocs = await Knowledge.find({
      $or: [
        { topic: { $in: regexQueries } },
        { content: { $in: regexQueries } }
      ]
    }).limit(5);

    let contextString = "";
    knowledgeDocs.forEach(doc => {
      contextString += `[OFFICIAL FACT] Topic: ${doc.topic} | Content: ${doc.content}\n`;
    });

    // 2. Search Conversations (ONLY available to Admin)
    if (isAdmin) {
      const convDocs = await Conversation.find({
        "messages.content": { $in: regexQueries }
      }).limit(5);

      convDocs.forEach(doc => {
        doc.messages.forEach(msg => {
          if (msg.role !== 'system' && regexQueries.some(rx => rx.test(msg.content))) {
            contextString += `[PAST ADMIN CHAT] ${msg.content}\n`;
          }
        });
      });
    }

    return contextString.trim();
  } catch (error) {
    console.error("Search Context Error:", error);
    return "";
  }
}

// API Route to handle chat messages
app.post('/api/chat', async (req, res) => {
  const { sessionId, message, adminKey } = req.body;
  
  // Robust admin check: requires both keys to exist and match
  const isAdmin = !!(adminKey && process.env.ADMIN_SECRET_KEY && adminKey === process.env.ADMIN_SECRET_KEY);

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'sessionId and message are required' });
  }

  try {
    // 1. Fetch relevant knowledge from MongoDB (RAG Search)
    // Pass the isAdmin flag to the search engine to restrict guest access
    const contextFacts = await getRelevantContext(message, isAdmin);

    // 2. Separate logic for Admin (History + Saving) vs Guest (Stateless)
    let messagesForGroq = [];

    if (isAdmin) {
      // ADMIN MODE: Full history management and database persistence
      let conversation = await Conversation.findOne({ sessionId });
      if (!conversation) {
        conversation = new Conversation({
          sessionId,
          messages: [SYSTEM_PROMPT]
        });
      }

      // Add user message to history
      conversation.messages.push({ role: 'user', content: message });

      // Prepare payload with last 10 messages for context
      messagesForGroq = [
        { role: 'system', content: SYSTEM_PROMPT.content + (contextFacts ? '\n\nRelevant Facts Found:\n' + contextFacts : '') },
        ...conversation.messages.slice(-10).map(msg => ({ role: msg.role, content: msg.content }))
      ];

      // Fetch AI Response
      const botReply = await callGroqAPI(messagesForGroq);

      // Save to MongoDB
      conversation.messages.push({ role: 'assistant', content: botReply });
      conversation.updatedAt = Date.now();
      await conversation.save();

      return res.json({ reply: botReply });

    } else {
      // GUEST MODE: Stateless. No history, no saving.
      messagesForGroq = [
        { role: 'system', content: SYSTEM_PROMPT.content + (contextFacts ? '\n\nRelevant Facts:\n' + contextFacts : '') },
        { role: 'user', content: message } // ONLY the current message
      ];

      const botReply = await callGroqAPI(messagesForGroq);
      
      // We DO NOT save anything to the database for guests
      return res.json({ reply: botReply });
    }

  } catch (error) {
    console.error('Error in /api/chat:', error);
    res.status(500).json({ error: 'Failed to process chat message' });
  }
});

/**
 * Helper to talk to Groq API
 */
async function callGroqAPI(messages) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: messages,
      temperature: 0.7,
      max_tokens: 1024
    })
  });

  if (!response.ok) throw new Error(`Groq API Error: ${response.status}`);
  const data = await response.json();
  return data.choices[0].message.content;
}

// API Route to load history
app.get('/api/history/:sessionId', async (req, res) => {
  try {
    const conversation = await Conversation.findOne({ sessionId: req.params.sessionId });
    if (conversation) {
      const historyToReturn = conversation.messages.filter(msg => msg.role !== 'system');
      res.json(historyToReturn);
    } else {
      res.json([]);
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
