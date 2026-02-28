const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';

// Basic authentication middleware
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.cookies.token;// thid line means 

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized - No token' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userRole = decoded.role || 'PLAYER';
    next();
  } catch (err) {
    console.error('Auth error:', err.message);
    return res.status(401).json({ error: 'Unauthorized - Invalid token' });
  }
};

module.exports = { authMiddleware };