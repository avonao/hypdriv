'use client';

import { useEffect, useState } from 'react';

/** Calls the protected route from the browser (initBotId attaches the challenge headers) and shows the verdict. */
export function BotIdProbe() {
  const [result, setResult] = useState('');
  useEffect(() => {
    fetch('/api/botid', { method: 'POST' })
      .then((r) => r.text())
      .then(setResult, (e: Error) => setResult(`error: ${e.message}`));
  }, []);
  return <output id="botid">{result}</output>;
}
