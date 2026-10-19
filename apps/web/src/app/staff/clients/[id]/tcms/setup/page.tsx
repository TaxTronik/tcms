import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  AUSFUEHRUNG_LABEL,
  fmtDatum,
  fmtDatumZeit,
  frequenzLabel,
  KATALOG_KONTROLLEN,
  KATALOG_RISIKEN,
  KLASSE_LABEL,
  KLASSE_RANG,
  KONTROLLART_LABEL,
  PAKET,
  PROFIL_FRAGEN,
  TURNUS_LABEL,
} from '@tcms/domain';
import { Icon } from '@/components/icon';
import { Leerzustand } from '@/components/ui/leer';
import {
  leseEntwurf,
  SCHRITTE,
  type EntwurfKontrolle,
  type SetupEntwurf,
} from '@/components/setup/entwurf';
import {
  Schrittleiste,
  StufeOffen,
  StufeZu,
  Zusammenfassung,
} from '@/components/setup/schrittleiste';
import {
  SchrittKontrollen,
  SchrittProfil,
  SchrittRisiken,
  SchrittTeilbereich,
  SchrittZiele,
  type KontrollGruppe,
  type KontrolleZeile,
  type RisikoZeile,
} from '@/components/setup/schritte';
import type { PersonInfo } from '@/components/profil/profil-formular';
import { speichereSchritt } from '@/server/actions/setup';
import { KEIN_RECHT } from '@/server/aktion';
import { personName } from '@/server/kontext';
import { berechnePlan, rollen, type Plan } from '@/server/programm-aufbau';
import { ladeStaffSeite, NUR_AKTUELL } from '@/server/seite';
import { ladeSetupProgramm, umfeldAusKontext } from '@/server/setup-daten';

export const metadata = { title: 'Einrichtungsassistent' };

const ROLLE: Record<string, string> = {
  GESETZLICHER_VERTRETER: 'Gesetzliche Vertretung',
  TAX_COMPLIANCE_BEAUFTRAGTER: 'Tax-Compliance-Beauftragte:r',
  MITARBEITER: 'Mitarbeit',
};

function kurzfassung(
  n: number,
  e: SetupEntwurf,
  plan: Plan,
  gvName: (id: string | null) => string,
): string {
  switch (n) {
    case 1:
      return `${e.teilbereich.name} · Angemessenheit zum ${fmtDatum(plan.zeitraum?.stichtag)} · Wirksamkeit ${fmtDatum(plan.zeitraum?.ab)} – ${fmtDatum(plan.zeitraum?.bis)} · Erklärungsturnus ${TURNUS_LABEL[e.zeitraum.erklaerungsTurnus]}`;
    case 2: {
      const kanaele = (e.profil.p1.eigenerShop ? 1 : 0) + e.profil.p1.marktplaetze.length;
      const n = (x: number, eins: string, viele: string) => `${x} ${x === 1 ? eins : viele}`;
      return `${n(kanaele, 'Verkaufskanal', 'Verkaufskanäle')} · ${n(e.profil.p3.laender.length, 'Zielland', 'Zielländer')} · ${n(e.profil.p2.lager.length, 'Lagerort', 'Lagerorte')} · ${plan.risiken.length} Risiken vorgeschlagen`;
    }
    case 3: {
      const aktiv = e.ziele.filter((z) => z.aktiv).length;
      return `${aktiv} Ziele · höchster Risikoappetit ${KLASSE_LABEL[plan.appetit]} · ${e.freigabe.anfordern ? `Freigabe bei ${gvName(e.freigabe.empfaengerId)} anfordern` : 'ohne Freigabeanforderung'}`;
    }
    case 4: {
      const ue = plan.risiken.filter((r) => r.uebernehmen);
      return `${ue.length} übernommen (davon ${ue.filter((r) => r.kern).length} Kernrisiken) · ${plan.risiken.length - ue.length} begründet abgelehnt`;
    }
    default:
      return `${plan.kontrollen.length} Kontrollen (${plan.kontrollen.filter((k) => k.kat.schluessel).length} Schlüssel) · ${plan.durchfuehrungen} Durchführungen geplant`;
  }
}

export default async function Einrichtungsassistent({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const seite = await ladeStaffSeite(id, sp);
  const { ctx, basis } = seite;
  const programm = await ladeSetupProgramm(id);
  const umfeld = umfeldAusKontext(ctx);
  const r = rollen(umfeld);
  const darf = seite.darfBearbeiten;
  const gesperrtGrund = ctx.historisch ? NUR_AKTUELL : KEIN_RECHT;

  // ---- Bereits eingerichtet ----
  if (programm && (programm.status === 'AKTIV' || programm.version1Am)) {
    return (
      <div style={{ maxWidth: 1100 }}>
        <h2 className="page-title">Einrichtungsassistent</h2>
        <div className="card mt-4">
          <Leerzustand
            icon="CheckCircle2"
            text={`Das Tax-CMS ist eingerichtet${programm.version1Am ? ` – Version 1 vom ${fmtDatumZeit(programm.version1Am)}` : ''}. Änderungen erfolgen in den Bereichen Profil, Risiken und Kontrollen.`}
          >
            <span className="row" style={{ justifyContent: 'center' }}>
              <Link className="btn-primary" href={basis}>
                Zum Cockpit
              </Link>
              <Link className="btn-secondary" href={`${basis}/profil`}>
                Geschäftsprofil
              </Link>
              <Link className="btn-secondary" href={`${basis}/risiken`}>
                Risikoinventar
              </Link>
            </span>
          </Leerzustand>
        </div>
      </div>
    );
  }

  // ---- Entwurf ----
  const entwurf = leseEntwurf(programm?.setupEntwurf, ctx.heute, r.gv);
  const max = Math.min(5, entwurf.abgeschlossen + 1);
  const roh = Number(Array.isArray(sp['schritt']) ? sp['schritt'][0] : sp['schritt']);
  const schritt = Number.isInteger(roh) && roh >= 1 ? Math.min(roh, max) : max;
  const plan = berechnePlan(entwurf, umfeld);
  const href = (n: number) => `${basis}/setup?schritt=${n}`;
  const gvListe = umfeld.mandantPersonen
    .filter((p) => p.mandantRolle === 'GESETZLICHER_VERTRETER')
    .map((p) => ({ id: p.id, name: p.name }));
  const gvName = (pid: string | null) => personName(ctx, pid);
  const formBasis = { aktion: speichereSchritt, mandantId: id, darf, gesperrtGrund };

  const personen: PersonInfo[] = umfeld.mandantPersonen
    .filter(
      (p) =>
        p.mandantRolle === 'GESETZLICHER_VERTRETER' ||
        p.mandantRolle === 'TAX_COMPLIANCE_BEAUFTRAGTER',
    )
    .map((p) => ({
      id: p.id,
      name: p.name,
      funktion: p.funktion,
      rolle: ROLLE[p.mandantRolle ?? ''] ?? 'Mandant',
    }));

  const unterzeilen: Record<number, string> = {
    1: `${PAKET.name} v${PAKET.version}`,
    2: `${PROFIL_FRAGEN.length} Profilfragen`,
    3: `${entwurf.ziele.filter((z) => z.aktiv).length} Ziele`,
    4:
      entwurf.abgeschlossen >= 2
        ? `${plan.risiken.filter((x) => x.uebernehmen).length} von ${plan.risiken.length} übernommen`
        : 'aus dem Profil',
    5: entwurf.abgeschlossen >= 4 ? `${plan.kontrollen.length} Kontrollen` : 'Zuständigkeiten',
  };

  // ---- Schrittinhalt ----
  let inhalt: ReactNode = null;
  if (schritt === 1) {
    inhalt = (
      <SchrittTeilbereich
        {...formBasis}
        start={{ teilbereich: entwurf.teilbereich, zeitraum: entwurf.zeitraum }}
        paket={{
          name: PAKET.name,
          version: PAKET.version,
          risiken: KATALOG_RISIKEN.length,
          kontrollen: KATALOG_KONTROLLEN.length,
          fragen: PROFIL_FRAGEN.length,
        }}
      />
    );
  } else if (schritt === 2) {
    inhalt = (
      <SchrittProfil
        {...formBasis}
        start={entwurf.profil}
        personen={personen}
        heuteIso={seite.heuteIso}
      />
    );
  } else if (schritt === 3) {
    inhalt = (
      <SchrittZiele
        {...formBasis}
        start={{ ziele: entwurf.ziele, freigabe: entwurf.freigabe }}
        gv={gvListe}
      />
    );
  } else if (schritt === 4) {
    const zeilen: RisikoZeile[] = plan.risiken.map((x) => ({
      code: x.code,
      titel: x.kat.titel,
      grund: x.grund,
      frage: x.frage,
      kern: x.kern,
      gt: x.kat.gt,
      brutto: x.brutto.klasse,
      bruttoErklaerung: x.brutto.erklaerung,
      ueberAppetit: x.ueberAppetit,
    }));
    inhalt = (
      <SchrittRisiken
        {...formBasis}
        zeilen={zeilen}
        start={entwurf.risiken}
        appetit={plan.appetit}
        nichtVorgeschlagen={plan.nichtVorgeschlagen.map((k) => ({
          code: k.code,
          titel: k.titel,
          anwendbarWenn: k.anwendbarWenn,
        }))}
      />
    );
  } else {
    const zeile = (k: Plan['kontrollen'][number]): KontrolleZeile => ({
      code: k.code,
      titel: k.kat.titel,
      art: `${KONTROLLART_LABEL[k.kat.art]} · ${AUSFUEHRUNG_LABEL[k.kat.ausfuehrung]}`,
      schluessel: k.kat.schluessel,
      review: k.kat.review,
      frequenz: frequenzLabel(k.ableitung.effektiv),
      ableitungKurz: k.ableitung.quelle
        ? `abgeleitet ${k.ableitung.quelle.gt} · ${KLASSE_LABEL[k.ableitung.quelle.brutto]}`
        : 'Vorlage, ohne Risikobezug',
      begruendung: `${k.ableitung.begruendung}; ${k.perioden.length} Durchführungen im Wirksamkeitszeitraum`,
      abweichend: k.ableitung.abweichendVonVorlage,
      vorlage: frequenzLabel(k.kat.frequenz),
      risikoCodes: k.risikoCodes,
      primaer: k.primaer,
      durchfuehrungen: k.perioden.length,
    });
    const uebernommen = plan.risiken
      .filter((x) => x.uebernehmen)
      .sort(
        (a, b) =>
          KLASSE_RANG[b.brutto.klasse] - KLASSE_RANG[a.brutto.klasse] ||
          a.code.localeCompare(b.code),
      );
    const gruppen: KontrollGruppe[] = uebernommen
      .map((x) => ({
        code: x.code,
        titel: x.kat.titel,
        brutto: x.brutto.klasse,
        kontrollen: plan.kontrollen.filter((k) => k.risikoCodes.includes(x.code)).map(zeile),
      }))
      .filter((g) => g.kontrollen.length > 0);
    const ohne = plan.kontrollen.filter((k) => k.risikoCodes.length === 0);
    if (ohne.length)
      gruppen.push({
        code: null,
        titel: 'Kultur und Kommunikation (ohne Risikobezug)',
        brutto: null,
        kontrollen: ohne.map(zeile),
      });
    const start: Record<string, EntwurfKontrolle> = Object.fromEntries(
      plan.kontrollen.map((k) => [
        k.code,
        {
          partei: k.zust.partei,
          durchfuehrendId: k.zust.durchfuehrendId,
          vertretungId: k.zust.vertretungId,
          gegenzeichnerId: k.zust.gegenzeichnerId,
        },
      ]),
    );
    inhalt = (
      <SchrittKontrollen
        {...formBasis}
        gruppen={gruppen}
        start={start}
        kanzlei={umfeld.kanzlei.map((p) => ({ id: p.id, name: p.name }))}
        mandant={umfeld.mandantPersonen.map((p) => ({ id: p.id, name: p.name }))}
        zusammenfassung={
          <Zusammenfassung
            d={{
              teilbereich: entwurf.teilbereich.name,
              stichtag: plan.zeitraum?.stichtag ?? null,
              wirksamAb: plan.zeitraum?.ab ?? null,
              wirksamBis: plan.zeitraum?.bis ?? null,
              turnus: entwurf.zeitraum.erklaerungsTurnus,
              ziele: entwurf.ziele.filter((z) => z.aktiv).length,
              appetit: plan.appetit,
              freigabeAn: entwurf.freigabe.anfordern ? gvName(entwurf.freigabe.empfaengerId) : null,
              risiken: uebernommen.length,
              kern: uebernommen.filter((x) => x.kern).length,
              abgelehnt: plan.risiken.length - uebernommen.length,
              kontrollen: plan.kontrollen.length,
              schluessel: plan.kontrollen.filter((k) => k.kat.schluessel).length,
              durchfuehrungen: plan.durchfuehrungen,
              prueflast: plan.prueflast,
            }}
          />
        }
      />
    );
  }

  const ansprech = umfeld.mandantPersonen.filter((p) => p.mandantRolle !== 'MITARBEITER');

  return (
    <div style={{ maxWidth: 1100 }}>
      <div className="mb-4">
        <h2 className="page-title">Einrichtungsassistent</h2>
        <p className="text-sm text-muted mt-1">
          Neues Tax-CMS in fünf Schritten —{' '}
          {programm && entwurf.gespeichertAm
            ? `Entwurf, zuletzt gespeichert am ${fmtDatumZeit(new Date(entwurf.gespeichertAm))}${entwurf.gespeichertVon ? ` von ${entwurf.gespeichertVon}` : ''}; noch keine Version angelegt.`
            : 'Entwurf, noch keine Version angelegt.'}
        </p>
      </div>

      {!darf ? (
        <div className="alert-warning mb-4 row-s" role="note">
          <Icon name="Lock" />
          <span>
            {ctx.historisch
              ? `${NUR_AKTUELL}.`
              : `${KEIN_RECHT} Bearbeiten dürfen Admin/Partner, zuständige Berufsträger und die Hauptbearbeitung.`}
          </span>
        </div>
      ) : null}

      <div className="card p-4 mb-4">
        <div className="row-between" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <span className="label">Mandant</span>
            <div className="text-sm font-s">{ctx.mandant.name}</div>
            <p className="hint">
              {programm
                ? 'Entwurf im Einrichtungsassistenten, noch keine Version'
                : 'noch kein Programm'}
            </p>
          </div>
          <div className="text-xs text-muted" style={{ textAlign: 'right' }}>
            {ansprech.map((p) => (
              <div key={p.id}>
                <span className="font-m text-secondary">
                  {ROLLE[p.mandantRolle ?? ''] ?? 'Mandant'}:
                </span>{' '}
                {p.name}
                {p.funktion ? ` (${p.funktion})` : ''}
              </div>
            ))}
            {ansprech.length === 0 ? (
              <div>Keine Ansprechpersonen beim Mandanten erfasst.</div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="card mb-4" style={{ padding: '18px 24px 12px' }}>
        <Schrittleiste
          aktiv={schritt}
          abgeschlossen={entwurf.abgeschlossen}
          href={href}
          unterzeilen={unterzeilen}
        />
      </div>

      {SCHRITTE.map((s) =>
        s.nr === schritt ? (
          <StufeOffen
            key={s.nr}
            nr={s.nr}
            titel={s.nr === 2 ? 'Geschäftsprofil (P1–P12)' : s.titel}
          >
            {inhalt}
          </StufeOffen>
        ) : (
          <StufeZu
            key={s.nr}
            nr={s.nr}
            titel={s.nr === 2 ? 'Geschäftsprofil (P1–P12)' : s.titel}
            erledigt={s.nr <= entwurf.abgeschlossen}
            text={
              s.nr <= entwurf.abgeschlossen
                ? kurzfassung(s.nr, entwurf, plan, gvName)
                : s.nr <= max
                  ? 'bereit'
                  : 'noch offen – erst nach den vorherigen Schritten'
            }
            href={s.nr <= max ? href(s.nr) : null}
          />
        ),
      )}
    </div>
  );
}
