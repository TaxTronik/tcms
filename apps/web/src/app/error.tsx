'use client';

import { Leerzustand } from '@/components/ui/leer';

// Eigene Fehlerseite: zeigt weder Meldung noch Stack (die stehen nur im Server-Log).
export default function Fehler({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="p-4">
      <Leerzustand icon="TriangleAlert" text="Die Seite konnte nicht geladen werden.">
        <button type="button" className="btn-secondary" onClick={() => reset()}>
          Erneut versuchen
        </button>
      </Leerzustand>
    </main>
  );
}
