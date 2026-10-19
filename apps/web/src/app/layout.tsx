import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/inter';
import './taxtronik.css';
import './app.css';

export const metadata: Metadata = {
  title: { default: 'Tax-CMS', template: '%s · Tax-CMS' },
  description: 'Tax Compliance Management System nach IDW PS 980 – Branchenpaket E-Commerce',
};

// Setzt die gespeicherte Darstellung vor dem ersten Paint (kein Flackern).
const THEME_BOOTSTRAP = `try{var t=localStorage.getItem('tcms-theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark')}}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
