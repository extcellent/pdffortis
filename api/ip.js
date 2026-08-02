export default function handler(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
          || req.socket?.remoteAddress
          || null;
  res.status(200).json({ ip });
}
