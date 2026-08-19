export default function notFoundMiddleware(req, res) {
  res.status(404).json({ error: { message: 'Route not found', category: 'NOT_FOUND' } });
}
