import Link from 'next/link';
import { Leerzustand } from '@/components/ui/leer';

// Eigene 404-Seite: kein Hinweis darauf, ob ein Objekt existiert (TS-03).
export default function NichtGefunden() {
  return (
    <main className="p-4">
      <Leerzustand icon="FileSearch" text="Nicht gefunden.">
        <Link href="/" className="btn-secondary">
          Zur Startseite
        </Link>
      </Leerzustand>
    </main>
  );
}
