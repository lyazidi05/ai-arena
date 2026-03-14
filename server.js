require('dotenv').config({ path: '.env' });

const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// ── CORS ──
const corsOptions = process.env.ALLOWED_ORIGIN
  ? { origin: process.env.ALLOWED_ORIGIN, optionsSuccessStatus: 200 }
  : { origin: '*' };
app.use(cors(corsOptions));

// ── Rate limiting ──
// General API limit: 120 req/min per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
});

// Stricter limit for write operations (register, train, action, bet)
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many write requests. Cooldown applies.' },
});

app.use('/api', apiLimiter);
app.use('/api/register', writeLimiter);
app.use('/api/train', writeLimiter);
app.use('/api/fight', writeLimiter);
app.use('/api/challenge', writeLimiter);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', apiRoutes);

app.get('/skill.md', (req, res) => {
  const skillPath = path.join(__dirname, 'public', 'skill.md');
  res.setHeader('Content-Type', 'text/markdown');
  res.sendFile(skillPath);
});

// Landing page at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// Arena dashboard
app.get('/arena', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Legal pages (clean URLs without .html)
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

// SPA catch-all → dashboard
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🥊 Clash of Agents running at http://localhost:${PORT}`);
  console.log(`📖 Skill file: http://localhost:${PORT}/skill.md`);
  console.log(`🎮 Frontend: http://localhost:${PORT}`);
  if (isProd) console.log('🚀 Production mode');
});
