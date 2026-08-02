export default async function handler(req, res) {
  // 1. Nur POST-Requests erlauben
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { prompt } = req.body;

  try {
    // 2. An das Vercel AI Gateway schicken
    const response = await fetch('https://ai-gateway.vercel.app/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AI_GATEWAY_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // Wähle hier exakt den Namen aus deiner Model List:
        model: 'inclusionai/ting-3.0-flash-free', 
        messages: [
          { role: 'system', content: 'Du bist ein nützlicher PDF-Support-Assistent.' },
          { role: 'user', content: prompt }
        ],
      }),
    });

    const data = await response.json();
    
    // 3. Antwort an das Frontend zurückgeben
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Fehler bei der KI-Anfrage' });
  }
}
