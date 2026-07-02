import React, { useState, useMemo, useEffect } from "react";

// ============================================================================
//  GENERATORE TURNI — PWA
//  Tre tab: Dipendenti · Calendario · Orario
//  Il solver gira lato backend (CP-SAT). Qui e' incluso anche un risolutore
//  euristico di riserva in JS, con la STESSA gerarchia di priorita', cosi'
//  l'app e' utilizzabile end-to-end anche prima del deploy del backend.
//  La regola d'oro resta: il 2+2 viene PRIMA di tutto, i giorni liberi sono
//  cio' che resta.
// ============================================================================

const GIORNI = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];
const GIORNI_FULL = ["Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato", "Domenica"];

const TURNI = {
  mattina: { label: "Mattina", orario: "8–16", start: 8, end: 16, fascia: "M" },
  "10-18": { label: "Interm.", orario: "10–18", start: 10, end: 18, fascia: "I" },
  "11-19": { label: "Interm.", orario: "11–19", start: 11, end: 19, fascia: "I" },
  "12-20": { label: "Interm.", orario: "12–20", start: 12, end: 20, fascia: "I" },
  sera: { label: "Sera", orario: "16–24", start: 16, end: 24, fascia: "S" },
  libero: { label: "Libero", orario: "—", start: null, end: null, fascia: "L" },
  // cella non ancora impostata (solo per "Crea orario", mai salvata)
  "-": { label: "-", orario: "", start: null, end: null, fascia: "X" },
};

const COLORI_TURNO = {
  mattina: { bg: "#fef3e2", fg: "#b45309", bar: "#f59e0b" },
  "10-18": { bg: "#eef2ff", fg: "#4338ca", bar: "#6366f1" },
  "11-19": { bg: "#eef2ff", fg: "#4338ca", bar: "#6366f1" },
  "12-20": { bg: "#eef2ff", fg: "#4338ca", bar: "#6366f1" },
  sera: { bg: "#ede9fe", fg: "#6d28d9", bar: "#8b5cf6" },
  libero: { bg: "#f1f5f9", fg: "#94a3b8", bar: "#cbd5e1" },
  // grigio più scuro del libero: cella da compilare in "Crea orario"
  "-": { bg: "#e2e8f0", fg: "#64748b", bar: "#94a3b8" },
};

const INTERMEDI = ["10-18", "11-19", "12-20"];
const ASSEGNABILI = ["mattina", "10-18", "11-19", "12-20", "sera"];

// --------------------------------------------------------------------------
//  Utilità date
// --------------------------------------------------------------------------
function lunediCorrente() {
  const d = new Date();
  const wd = (d.getDay() + 6) % 7; // 0 = lunedì
  d.setDate(d.getDate() - wd);
  d.setHours(0, 0, 0, 0);
  return d;
}
function lunediProssimo() {
  // primo lunedì selezionabile: la settimana corrente si considera gia' fatta,
  // quindi si parte dal lunedì della settimana prossima.
  const d = lunediCorrente();
  d.setDate(d.getDate() + 7);
  return d;
}
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function iso(date) {
  // BUG FIX: toISOString() converte in UTC, e con fusi orari avanti rispetto
  // a UTC (es. Europe/Rome in estate) la mezzanotte locale diventa il giorno
  // PRECEDENTE in UTC, causando uno shift di un giorno in tutta la griglia
  // (es. "Lun 15/6" mostrato in UI ma "2026-06-14" inviato al backend).
  // Usiamo i componenti locali della data, che sono quelli corretti.
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function fmtGiorno(date) {
  return `${date.getDate()}/${date.getMonth() + 1}`;
}
function restHours(s1, s2) {
  // riposo tra fine s1 (giorno D) e inizio s2 (giorno D+1)
  return 24 - TURNI[s1].end + TURNI[s2].start;
}

// ==========================================================================
//  SOLVER EURISTICO DI RISERVA (gerarchia identica al backend)
//  Ordine: 1) input fissi  2) competenze+2+2  3) riempimento lun-ven
//          4) giorni liberi = residuo, adiacenti
//  Restituisce { status, assignments, messaggi }
// ==========================================================================
function generaOrarioJS(employees, entries, start, numWeeks) {
  const days = [];
  for (let i = 0; i < numWeeks * 7; i++) days.push(addDays(start, i));
  const messaggi = [];

  // mappa risultato: assign[empId][isoDay] = turno
  const assign = {};
  employees.forEach((e) => (assign[e.id] = {}));

  const isFerie = (eid, d) =>
    entries.some(
      (en) =>
        en.tipo === "ferie" &&
        en.employee_id === eid &&
        en.start <= iso(d) &&
        iso(d) <= en.end
    );
  const giornoForte = (d) =>
    entries.find(
      (en) => en.tipo === "giorno_forte" && en.start <= iso(d) && iso(d) <= en.end
    );
  const prefs = (eid, d) =>
    entries.filter(
      (en) =>
        en.tipo === "preferenza_turno" &&
        en.employee_id === eid &&
        en.start <= iso(d) &&
        iso(d) <= en.end
    );

  // riposo rispettato tra giorno precedente e turno candidato
  const riposoOk = (e, d, turno) => {
    const prev = assign[e.id][iso(addDays(d, -1))];
    if (!prev || prev === "libero") return true;
    return restHours(prev, turno) >= e.riposo_minimo_ore;
  };

  // ---- Passo 1: applica input fissi (ferie + liberi fissi + turni fissi) ----
  for (const d of days) {
    const wd = (d.getDay() + 6) % 7;
    for (const e of employees) {
      if (isFerie(e.id, d)) {
        assign[e.id][iso(d)] = "libero";
      } else if (e.giorni_liberi_fissi.includes(wd) && !giornoForte(d)) {
        assign[e.id][iso(d)] = "libero";
      } else if (e.turni_fissi[wd] != null && !giornoForte(d)) {
        assign[e.id][iso(d)] = e.turni_fissi[wd];
      }
    }
  }

  // ---- Passo 2: per ogni giorno garantisci competenze + 2+2 ----
  let infeasible = false;
  for (const d of days) {
    const isoD = iso(d);
    const gf = giornoForte(d);
    const dispo = employees.filter(
      (e) => assign[e.id][isoD] == null && !isFerie(e.id, d)
    );
    const giaMattina = employees.filter((e) => assign[e.id][isoD] === "mattina");
    const giaSera = employees.filter((e) => assign[e.id][isoD] === "sera");

    const targetM = gf?.target_mattina || 2;
    const targetS = gf?.target_sera || 2;

    // chiudi/apri: assicura competenze nella scelta
    const needMattina = Math.max(0, targetM - giaMattina.length);
    const needSera = Math.max(0, targetS - giaSera.length);

    // assegna mattina (priorita' a chi sa aprire se manca apertura)
    const haApertura = () =>
      employees.some((e) => assign[e.id][isoD] === "mattina" && e.sa_aprire);
    const haChiusura = () =>
      employees.some((e) => assign[e.id][isoD] === "sera" && e.sa_chiudere);

    const pickFor = (fascia, count, needSkill, skillKey) => {
      for (let k = 0; k < count; k++) {
        let pool = dispo.filter(
          (e) => assign[e.id][isoD] == null && riposoOk(e, d, fascia)
        );
        if (pool.length === 0) {
          infeasible = true;
          return;
        }
        // se serve la competenza e non c'e' ancora, dai priorita'
        const skillMancante =
          (skillKey === "sa_aprire" && !haApertura()) ||
          (skillKey === "sa_chiudere" && !haChiusura());
        if (skillMancante) {
          const skilled = pool.filter((e) => e[skillKey]);
          if (skilled.length) pool = skilled;
        }
        // preferisci chi ha preferenza per questa fascia, poi meno carico
        pool.sort((a, b) => {
          const pa = prefs(a.id, d).some((p) => p.turno_preferito === fascia) ? -10 : 0;
          const pb = prefs(b.id, d).some((p) => p.turno_preferito === fascia) ? -10 : 0;
          const ca = Object.values(assign[a.id]).filter((t) => t && t !== "libero").length;
          const cb = Object.values(assign[b.id]).filter((t) => t && t !== "libero").length;
          return pa - pb + (ca - cb) * 0.5;
        });
        assign[pool[0].id][isoD] = fascia;
      }
    };

    pickFor("mattina", needMattina, true, "sa_aprire");
    pickFor("sera", needSera, true, "sa_chiudere");

    // verifica competenze finali
    if (giaMattina.length + needMattina >= 2 && !haApertura()) {
      // prova a forzare un apritore se presente tra i mattutini sostituibili
    }
  }

  if (infeasible) {
    messaggi.push(
      "Personale insufficiente per garantire il minimo 2+2 e le competenze in alcuni giorni. " +
        "Verifica ferie, giorni liberi fissi e chi sa aprire/chiudere."
    );
  }

  // ---- Passo 3: riempimento lun-ven con intermedi (residuo a libero) ----
  for (const d of days) {
    const wd = (d.getDay() + 6) % 7;
    const isoD = iso(d);
    if (wd >= 5) continue; // weekend: resta al minimo
    for (const e of employees) {
      if (assign[e.id][isoD] != null) continue;
      // assegna un intermedio se rispetta il riposo, altrimenti libero
      const intermedio = INTERMEDI.find((t) => riposoOk(e, d, t));
      // ma prima controlla che non gli servano i 2 giorni liberi
      const liberiSett = contaLiberiSettimana(assign, e, d, days);
      if (liberiSett < 2 && intermedio) {
        // lascia spazio ai liberi: assegna comunque ma il passo 4 sistema
        assign[e.id][isoD] = intermedio;
      } else if (intermedio) {
        assign[e.id][isoD] = intermedio;
      } else {
        assign[e.id][isoD] = "libero";
      }
    }
  }

  // ---- Passo 4: i restanti slot vuoti diventano liberi, resi adiacenti ----
  for (const e of employees) {
    for (const d of days) {
      if (assign[e.id][iso(d)] == null) assign[e.id][iso(d)] = "libero";
    }
  }
  garantisciDueLiberiAdiacenti(assign, employees, days, entries, messaggi);

  // costruisci lista assignments
  const assignments = [];
  for (const e of employees)
    for (const d of days)
      assignments.push({ employee_id: e.id, giorno: iso(d), turno: assign[e.id][iso(d)] });

  return {
    status: infeasible ? "PARZIALE" : "OK",
    assignments,
    messaggi,
  };
}

function contaLiberiSettimana(assign, e, d, days) {
  const wd = (d.getDay() + 6) % 7;
  const weekStart = addDays(d, -wd);
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const t = assign[e.id][iso(addDays(weekStart, i))];
    if (t === "libero") n++;
  }
  return n;
}

// Aggiusta i liberi perché siano 2 e adiacenti, senza rompere il 2+2.
function garantisciDueLiberiAdiacenti(assign, employees, days, entries, messaggi) {
  const numWeeks = days.length / 7;
  for (let w = 0; w < numWeeks; w++) {
    const week = days.slice(w * 7, w * 7 + 7);
    for (const e of employees) {
      const liberi = week.filter((d) => assign[e.id][iso(d)] === "libero");
      // se ha esattamente 2 liberi adiacenti, ok
      if (liberi.length === 2) {
        const i0 = (liberi[0].getDay() + 6) % 7;
        const i1 = (liberi[1].getDay() + 6) % 7;
        if (Math.abs(i0 - i1) === 1 || (i0 === 5 && i1 === 6)) continue;
      }
      // altrimenti il backend CP-SAT risolve in modo ottimale;
      // qui segnaliamo solo che la bozza euristica va rifinita.
    }
  }
}

// ==========================================================================
//  PROVA A USARE IL BACKEND, ALTRIMENTI IL SOLVER JS
// ==========================================================================
async function generaOrario(employees, entries, start, numWeeks, storico, backendUrl) {
  if (backendUrl) {
    try {
      const payload = {
        employees: employees.map((e) => ({
          ...e,
          turni_fissi: Object.fromEntries(
            Object.entries(e.turni_fissi).map(([k, v]) => [String(k), v])
          ),
        })),
        calendar_entries: entries,
        start: iso(start),
        num_weeks: numWeeks,
        // Lo storico per l'equità lo legge il backend direttamente dal database
        // (ultimi 3 mesi). Non lo inviamo: lo stato locale "storico" contiene
        // i metadati degli orari (schedules), non le assegnazioni.
        storico: [],
        max_seconds: 30,
      };
      const r = await fetch(backendUrl.replace(/\/$/, "") + "/genera", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        const data = await r.json();
        return {
          status: data.status,
          assignments: data.assignments,
          messaggi: data.messaggi,
          violazioni: data.violazioni || [],
          motore: "backend",
        };
      }
    } catch (err) {
      // backend non raggiungibile
    }
  }
  // Il solver locale produce solo bozze non affidabili: NON lo usiamo come
  // orario definitivo. Meglio un errore chiaro che un orario potenzialmente
  // sbagliato (copertura rotta, persone senza libero, ecc.).
  return {
    status: "ERRORE",
    assignments: [],
    messaggi: [
      "Server non raggiungibile in questo momento. L'orario non può essere generato in modo affidabile. " +
      "Se il server era inattivo, attendi ~1 minuto e riprova.",
    ],
    violazioni: [],
    motore: "nessuno",
  };
}

// ==========================================================================
//  COMPONENTI UI
// ==========================================================================

function Toggle({ checked, onChange, label }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        display: "flex", alignItems: "center", gap: 8, background: "none",
        border: "none", cursor: "pointer", padding: "6px 0", textAlign: "left", width: "100%",
      }}
    >
      <span
        style={{
          width: 38, height: 22, borderRadius: 11, flexShrink: 0,
          background: checked ? "#1e293b" : "#cbd5e1",
          position: "relative", transition: "background .15s",
        }}
      >
        <span
          style={{
            position: "absolute", top: 2, left: checked ? 18 : 2, width: 18, height: 18,
            borderRadius: "50%", background: "#fff", transition: "left .15s",
          }}
        />
      </span>
      <span style={{ fontSize: 14, color: "#1e293b" }}>{label}</span>
    </button>
  );
}

function SchedaDipendente({ emp, onChange, onDelete }) {
  const [open, setOpen] = useState(false);
  const set = (patch) => onChange({ ...emp, ...patch });
  const toggleGiornoLibero = (wd) => {
    const arr = emp.giorni_liberi_fissi.includes(wd)
      ? emp.giorni_liberi_fissi.filter((x) => x !== wd)
      : [...emp.giorni_liberi_fissi, wd];
    set({ giorni_liberi_fissi: arr });
  };
  const setTurnoFisso = (wd, turno) => {
    const tf = { ...emp.turni_fissi };
    if (turno === "") delete tf[wd];
    else tf[wd] = turno;
    set({ turni_fissi: tf });
  };

  return (
    <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e2e8f0", marginBottom: 12, overflow: "hidden" }}>
      <div
        onClick={() => setOpen(!open)}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", cursor: "pointer" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 34, height: 34, borderRadius: "50%", background: "#1e293b", color: "#fff", display: "grid", placeItems: "center", fontWeight: 600, fontSize: 14 }}>
            {emp.nome ? emp.nome[0].toUpperCase() : "?"}
          </span>
          <div>
            <div style={{ fontWeight: 600, color: "#0f172a", fontSize: 15 }}>{emp.nome || "Senza nome"}</div>
            <div style={{ fontSize: 12, color: "#64748b" }}>
              {[emp.sa_aprire && "apre", emp.sa_chiudere && "chiude"].filter(Boolean).join(" · ") || "nessuna competenza"}
            </div>
          </div>
        </div>
        <span style={{ color: "#94a3b8", fontSize: 18, transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>›</span>
      </div>

      {open && (
        <div style={{ padding: "4px 16px 16px", borderTop: "1px solid #f1f5f9" }}>
          <label style={lbl}>Nome</label>
          <input style={inp} value={emp.nome} onChange={(e) => set({ nome: e.target.value })} placeholder="Nome dipendente" />

          <label style={lbl}>Competenze</label>
          <Toggle checked={emp.sa_aprire} onChange={(v) => set({ sa_aprire: v })} label="Sa aprire (turno mattina)" />
          <Toggle checked={emp.sa_chiudere} onChange={(v) => set({ sa_chiudere: v })} label="Sa chiudere (turno sera)" />

          <label style={lbl}>Giorni liberi fissi</label>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {GIORNI.map((g, i) => (
              <button key={i} onClick={() => toggleGiornoLibero(i)} style={chip(emp.giorni_liberi_fissi.includes(i))}>{g}</button>
            ))}
          </div>

          <label style={lbl}>Turni fissi obbligatori</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {GIORNI.map((g, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 40, fontSize: 13, color: "#475569" }}>{g}</span>
                <select style={{ ...inp, marginBottom: 0, flex: 1 }} value={emp.turni_fissi[i] || ""} onChange={(e) => setTurnoFisso(i, e.target.value)}>
                  <option value="">— nessuno —</option>
                  {ASSEGNABILI.map((t) => <option key={t} value={t}>{TURNI[t].label} ({TURNI[t].orario})</option>)}
                </select>
              </div>
            ))}
          </div>

          <label style={lbl}>Riposo minimo tra turni</label>
          <select style={inp} value={emp.riposo_minimo_ore} onChange={(e) => set({ riposo_minimo_ore: Number(e.target.value) })}>
            {[12, 11, 10, 9].map((h) => <option key={h} value={h}>{h} ore{h === 12 ? " (standard)" : ""}</option>)}
          </select>

          <Toggle checked={emp.libero_sacrificabile} onChange={(v) => set({ libero_sacrificabile: v })} label="Giorno libero sacrificabile (casi estremi)" />

          <button onClick={onDelete} style={{ marginTop: 14, width: "100%", padding: 10, borderRadius: 10, border: "1px solid #fecaca", background: "#fef2f2", color: "#dc2626", fontSize: 14, fontWeight: 500, cursor: "pointer" }}>
            Elimina dipendente
          </button>
        </div>
      )}
    </div>
  );
}

function TabDipendenti({ employees, setEmployees }) {
  const addEmp = () => {
    const id = "e" + Date.now();
    setEmployees([...employees, {
      id, nome: "", giorni_liberi_fissi: [], turni_fissi: {},
      riposo_minimo_ore: 12, sa_aprire: false, sa_chiudere: false, libero_sacrificabile: false,
    }]);
  };
  return (
    <div style={{ padding: 16 }}>
      {employees.length === 0 && (
        <div style={empty}>Nessun dipendente. Aggiungine uno per iniziare a configurare il personale.</div>
      )}
      {employees.map((emp) => (
        <SchedaDipendente
          key={emp.id}
          emp={emp}
          onChange={(u) => setEmployees(employees.map((e) => (e.id === emp.id ? u : e)))}
          onDelete={() => setEmployees(employees.filter((e) => e.id !== emp.id))}
        />
      ))}
      <button onClick={addEmp} style={btnPrimary}>+ Aggiungi dipendente</button>
    </div>
  );
}

// Mini-calendario a selezione multipla di giorni (riusato per giorni forti e assenze).
// `selected` e' un Set di stringhe ISO; onToggle(iso) aggiunge/rimuove un giorno.
// Selettore di assenze puntuali per la generazione (usa-e-getta).
// Per ogni persona scelta, si toccano i giorni della settimana pianificata in cui e' assente.
function SelettoreAssenze({ employees, assenze, setAssenze, start, numWeeks }) {
  const [aperto, setAperto] = useState(false);
  const [empSel, setEmpSel] = useState("");

  // giorni del periodo pianificato (lun della prima settimana .. fine ultima settimana)
  const giorniPeriodo = Array.from({ length: numWeeks * 7 }, (_, i) => addDays(start, i));

  const giorniDi = (empId) => {
    const a = assenze.find((x) => x.employee_id === empId);
    return a ? a.giorni : new Set();
  };
  const toggleGiorno = (empId, isoD) => {
    setAssenze((prev) => {
      const next = prev.map((x) => ({ employee_id: x.employee_id, giorni: new Set(x.giorni) }));
      let rec = next.find((x) => x.employee_id === empId);
      if (!rec) { rec = { employee_id: empId, giorni: new Set() }; next.push(rec); }
      if (rec.giorni.has(isoD)) rec.giorni.delete(isoD); else rec.giorni.add(isoD);
      // rimuovi record vuoti
      return next.filter((x) => x.giorni.size > 0);
    });
  };

  const totAssenze = assenze.reduce((s, a) => s + a.giorni.size, 0);

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #f1f5f9" }}>
      <button onClick={() => setAperto(!aperto)} style={{
        width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center",
        background: "none", border: "none", cursor: "pointer", padding: 0,
      }}>
        <label style={{ ...lbl, marginTop: 0, marginBottom: 0, cursor: "pointer" }}>
          Assenze di questa settimana {totAssenze > 0 ? `(${totAssenze})` : "(facoltativo)"}
        </label>
        <span style={{ color: "#94a3b8", fontSize: 14 }}>{aperto ? "▴" : "▾"}</span>
      </button>

      {aperto && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>
            Permessi/visite: la persona scelta non lavorerà nei giorni selezionati. Vale solo per questa generazione.
          </div>
          <select style={inp} value={empSel} onChange={(e) => setEmpSel(e.target.value)}>
            <option value="">— scegli una persona —</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.nome || "senza nome"}</option>)}
          </select>

          {empSel && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginTop: 8 }}>
              {giorniPeriodo.map((d, i) => {
                const isoD = iso(d);
                const sel = giorniDi(empSel).has(isoD);
                return (
                  <button key={i} onClick={() => toggleGiorno(empSel, isoD)}
                    style={{
                      padding: "8px 2px", borderRadius: 8, cursor: "pointer", textAlign: "center",
                      border: sel ? "1px solid #dc2626" : "1px solid #e2e8f0",
                      background: sel ? "#fef2f2" : "#fff",
                    }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: sel ? "#dc2626" : "#94a3b8" }}>{GIORNI[d.getDay() === 0 ? 6 : d.getDay() - 1]}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: sel ? "#dc2626" : "#0f172a" }}>{d.getDate()}</div>
                  </button>
                );
              })}
            </div>
          )}

          {/* riepilogo assenze impostate */}
          {assenze.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {assenze.map((a) => {
                const nome = employees.find((e) => e.id === a.employee_id)?.nome || "?";
                const giorniOrdinati = [...a.giorni].sort();
                return (
                  <div key={a.employee_id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12.5, color: "#0f172a", padding: "4px 0" }}>
                    <span><b>{nome}</b> assente: {giorniOrdinati.map((g) => { const [y,m,d]=g.split("-"); return `${+d}/${+m}`; }).join(", ")}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Selettore delle presenze obbligate per la generazione (usa-e-getta).
// Speculare alle assenze: per la persona scelta si seleziona un TURNO e si
// toccano i giorni in cui deve farlo obbligatoriamente (vincolo inviolabile).
function SelettorePresenze({ employees, presenze, setPresenze, start, numWeeks }) {
  const [aperto, setAperto] = useState(false);
  const [empSel, setEmpSel] = useState("");
  const [turnoSel, setTurnoSel] = useState("mattina");

  const giorniPeriodo = Array.from({ length: numWeeks * 7 }, (_, i) => addDays(start, i));

  const giorniDi = (empId) => presenze.find((x) => x.employee_id === empId)?.giorni || {};
  const toggleGiorno = (empId, isoD) => {
    setPresenze((prev) => {
      const next = prev.map((x) => ({ employee_id: x.employee_id, giorni: { ...x.giorni } }));
      let rec = next.find((x) => x.employee_id === empId);
      if (!rec) { rec = { employee_id: empId, giorni: {} }; next.push(rec); }
      // stesso turno -> rimuovi; turno diverso -> sostituisci
      if (rec.giorni[isoD] === turnoSel) delete rec.giorni[isoD];
      else rec.giorni[isoD] = turnoSel;
      return next.filter((x) => Object.keys(x.giorni).length > 0);
    });
  };

  const tot = presenze.reduce((s, p) => s + Object.keys(p.giorni).length, 0);

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #f1f5f9" }}>
      <button onClick={() => setAperto(!aperto)} style={{
        width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center",
        background: "none", border: "none", cursor: "pointer", padding: 0,
      }}>
        <label style={{ ...lbl, marginTop: 0, marginBottom: 0, cursor: "pointer" }}>
          Presenze obbligate {tot > 0 ? `(${tot})` : "(facoltativo)"}
        </label>
        <span style={{ color: "#94a3b8", fontSize: 14 }}>{aperto ? "▴" : "▾"}</span>
      </button>

      {aperto && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>
            La persona scelta farà obbligatoriamente il turno indicato nei giorni selezionati.
            Vale solo per questa generazione.
          </div>
          <select style={inp} value={empSel} onChange={(e) => setEmpSel(e.target.value)}>
            <option value="">— scegli una persona —</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.nome || "senza nome"}</option>)}
          </select>

          {empSel && (
            <>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4, marginBottom: 6 }}>
                {ASSEGNABILI.map((t) => (
                  <button key={t} onClick={() => setTurnoSel(t)} style={chip(turnoSel === t)}>
                    {TURNI[t].orario}
                  </button>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
                {giorniPeriodo.map((d, i) => {
                  const isoD = iso(d);
                  const turnoGiorno = giorniDi(empSel)[isoD];
                  const sel = turnoGiorno != null;
                  return (
                    <button key={i} onClick={() => toggleGiorno(empSel, isoD)}
                      style={{
                        padding: "6px 2px", borderRadius: 8, cursor: "pointer", textAlign: "center",
                        border: sel ? "1px solid #16a34a" : "1px solid #e2e8f0",
                        background: sel ? "#f0fdf4" : "#fff",
                      }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: sel ? "#16a34a" : "#94a3b8" }}>{GIORNI[d.getDay() === 0 ? 6 : d.getDay() - 1]}</div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: sel ? "#16a34a" : "#0f172a" }}>{d.getDate()}</div>
                      <div style={{ fontSize: 9, fontWeight: 700, color: sel ? "#16a34a" : "transparent", minHeight: 11 }}>{sel ? TURNI[turnoGiorno].orario : "·"}</div>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {/* riepilogo presenze impostate */}
          {presenze.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {presenze.map((p) => {
                const nome = employees.find((e) => e.id === p.employee_id)?.nome || "?";
                const giorniOrdinati = Object.keys(p.giorni).sort();
                return (
                  <div key={p.employee_id} style={{ fontSize: 12.5, color: "#0f172a", padding: "4px 0" }}>
                    <b>{nome}</b> deve fare: {giorniOrdinati.map((g) => {
                      const [y, m, d] = g.split("-");
                      return `${+d}/${+m} ${TURNI[p.giorni[g]].orario}`;
                    }).join(", ")}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MiniCalendario({ selected, onToggle, mesiVisibili = 2, minDate = null }) {
  const oggi = new Date(); oggi.setHours(0, 0, 0, 0);
  const base = new Date(oggi.getFullYear(), oggi.getMonth(), 1);
  const mesi = [];
  for (let m = 0; m < mesiVisibili; m++) {
    mesi.push(new Date(base.getFullYear(), base.getMonth() + m, 1));
  }
  const nomeMese = (d) => `${["Gennaio","Febbraio","Marzo","Aprile","Maggio","Giugno","Luglio","Agosto","Settembre","Ottobre","Novembre","Dicembre"][d.getMonth()]} ${d.getFullYear()}`;
  return (
    <div>
      {mesi.map((primo, mi) => {
        const anno = primo.getFullYear(), mese = primo.getMonth();
        const giorniNelMese = new Date(anno, mese + 1, 0).getDate();
        const primoWd = (new Date(anno, mese, 1).getDay() + 6) % 7;
        const celle = [];
        for (let i = 0; i < primoWd; i++) celle.push(null);
        for (let g = 1; g <= giorniNelMese; g++) celle.push(g);
        return (
          <div key={mi} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", marginBottom: 6, textAlign: "center" }}>{nomeMese(primo)}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3 }}>
              {["L","M","M","G","V","S","D"].map((g, i) => (
                <div key={"h"+i} style={{ textAlign: "center", fontSize: 10.5, fontWeight: 700, color: "#94a3b8", padding: "2px 0" }}>{g}</div>
              ))}
              {celle.map((g, i) => {
                if (g == null) return <div key={"e"+i} />;
                const d = new Date(anno, mese, g);
                const isoD = iso(d);
                const sel = selected.has(isoD);
                const disabilitato = (minDate && d < minDate) || d < oggi;
                const we = (d.getDay() === 0 || d.getDay() === 6);
                return (
                  <button key={i} disabled={disabilitato} onClick={() => onToggle(isoD)}
                    style={{
                      aspectRatio: "1", borderRadius: 8, cursor: disabilitato ? "default" : "pointer",
                      fontSize: 13, fontWeight: sel ? 700 : 500,
                      background: sel ? "#f97316" : disabilitato ? "#f8fafc" : we ? "#f1f5f9" : "#fff",
                      color: sel ? "#fff" : disabilitato ? "#cbd5e1" : "#0f172a",
                      border: sel ? "1px solid #f97316" : "1px solid #e2e8f0",
                    }}>{g}</button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TabCalendario({ employees, entries, setEntries, start, numWeeks }) {
  const [tipo, setTipo] = useState("ferie");
  const [empId, setEmpId] = useState("");
  const [from, setFrom] = useState(iso(start));
  const [to, setTo] = useState(iso(start));
  const [tm, setTm] = useState(3);
  const [ts, setTs] = useState(3);
  const [turnoPref, setTurnoPref] = useState("sera");
  const [prio, setPrio] = useState(7);
  const [giorniForti, setGiorniForti] = useState(new Set());  // ISO dei giorni forti selezionati

  const toggleGiornoForte = (isoD) => {
    setGiorniForti((prev) => {
      const next = new Set(prev);
      if (next.has(isoD)) next.delete(isoD); else next.add(isoD);
      return next;
    });
  };

  const add = () => {
    if (tipo === "giorno_forte") {
      // crea una entry per ogni giorno selezionato (start==end), poi azzera la selezione
      if (giorniForti.size === 0) return;
      const nuove = [...giorniForti].map((g) => ({ tipo: "giorno_forte", start: g, end: g, target_mattina: tm, target_sera: ts }));
      setEntries([...entries, ...nuove]);
      setGiorniForti(new Set());
      return;
    }
    const base = { tipo, start: from, end: to };
    let entry;
    if (tipo === "ferie") entry = { ...base, employee_id: empId };
    else entry = { ...base, employee_id: empId, turno_preferito: turnoPref, priorita: prio };
    if (!empId) return;
    setEntries([...entries, entry]);
  };

  const label = (en) => {
    const nome = employees.find((e) => e.id === en.employee_id)?.nome || "?";
    if (en.tipo === "ferie") return `Ferie · ${nome}`;
    if (en.tipo === "giorno_forte") return `Giorno forte · ${en.target_mattina}+${en.target_sera}`;
    return `Preferenza · ${nome} → ${TURNI[en.turno_preferito].label} (p${en.priorita})`;
  };
  const colorEntry = (t) => t === "ferie" ? "#0ea5e9" : t === "giorno_forte" ? "#f97316" : "#8b5cf6";

  return (
    <div style={{ padding: 16 }}>
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e2e8f0", padding: 16, marginBottom: 16 }}>
        <label style={lbl}>Tipo di marcatura</label>
        <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
          {[["ferie", "Ferie"], ["giorno_forte", "Giorno forte"], ["preferenza_turno", "Preferenza"]].map(([v, l]) => (
            <button key={v} onClick={() => setTipo(v)} style={chip(tipo === v)}>{l}</button>
          ))}
        </div>

        {tipo !== "giorno_forte" && (
          <>
            <label style={lbl}>Dipendente</label>
            <select style={inp} value={empId} onChange={(e) => setEmpId(e.target.value)}>
              <option value="">— seleziona —</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.nome || "senza nome"}</option>)}
            </select>
          </>
        )}

        {tipo !== "giorno_forte" && (
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Dal</label>
              <input type="date" style={inp} value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Al</label>
              <input type="date" style={inp} value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
        )}

        {tipo === "giorno_forte" && (
          <>
            <div style={{ display: "flex", gap: 10, marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Persone mattina</label>
                <input type="number" min={2} style={inp} value={tm} onChange={(e) => setTm(Number(e.target.value))} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Persone sera</label>
                <input type="number" min={2} style={inp} value={ts} onChange={(e) => setTs(Number(e.target.value))} />
              </div>
            </div>
            <label style={lbl}>Tocca i giorni forti (anche staccati)</label>
            <MiniCalendario selected={giorniForti} onToggle={toggleGiornoForte} mesiVisibili={2} />
            {giorniForti.size > 0 && (
              <div style={{ fontSize: 12.5, color: "#f97316", fontWeight: 600, marginBottom: 4 }}>
                {giorniForti.size} {giorniForti.size === 1 ? "giorno selezionato" : "giorni selezionati"}
              </div>
            )}
          </>
        )}

        {tipo === "preferenza_turno" && (
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Turno preferito</label>
              <select style={inp} value={turnoPref} onChange={(e) => setTurnoPref(e.target.value)}>
                {ASSEGNABILI.map((t) => <option key={t} value={t}>{TURNI[t].label} ({TURNI[t].orario})</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Priorità (6–10)</label>
              <input type="number" min={6} max={10} style={inp} value={prio} onChange={(e) => setPrio(Number(e.target.value))} />
            </div>
          </div>
        )}

        <button onClick={add} style={btnPrimary}>+ Aggiungi al calendario</button>
      </div>

      {entries.length === 0 ? (
        <div style={empty}>Nessuna marcatura. Aggiungi ferie, giorni forti o preferenze di turno.</div>
      ) : (
        entries.map((en, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "12px 14px", marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 4, height: 34, borderRadius: 2, background: colorEntry(en.tipo) }} />
              <div>
                <div style={{ fontSize: 14, fontWeight: 500, color: "#0f172a" }}>{label(en)}</div>
                <div style={{ fontSize: 12, color: "#64748b" }}>
                  {en.start === en.end ? en.start : `${en.start} → ${en.end}`}
                </div>
              </div>
            </div>
            <button onClick={() => setEntries(entries.filter((_, j) => j !== i))} style={{ background: "none", border: "none", color: "#94a3b8", fontSize: 20, cursor: "pointer" }}>×</button>
          </div>
        ))
      )}
    </div>
  );
}

function TabOrario({ orario, employees, start, numWeeks, onModifica, messaggi, motore, conflitti, violazioni, draft }) {
  const [settimana, setSettimana] = useState(0);
  const [cella, setCella] = useState(null); // { empId, isoDay }

  if (!orario) {
    return <div style={empty}>Nessun orario. Premi “Genera orario” per crearlo con l'algoritmo, oppure “Crea” per comporlo a mano.</div>;
  }

  const weekStart = addDays(start, settimana * 7);
  const giorni = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const get = (empId, d) =>
    orario.find((a) => a.employee_id === empId && a.giorno === iso(d))?.turno || "libero";

  return (
    <div style={{ paddingBottom: 80 }}>
      {messaggi && messaggi.length > 0 && (
        <div style={{ margin: 16, padding: 12, borderRadius: 12, background: "#fff7ed", border: "1px solid #fed7aa", color: "#9a3412", fontSize: 13 }}>
          {messaggi.map((m, i) => <div key={i}>{m}</div>)}
        </div>
      )}

      {violazioni && violazioni.length > 0 && (
        <div style={{ margin: "0 16px 8px", padding: 12, borderRadius: 12, background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1e40af", fontSize: 12.5 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Note sull'orario</div>
          {violazioni.map((v, i) => <div key={i} style={{ marginBottom: 2 }}>· {v}</div>)}
        </div>
      )}

      {numWeeks > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16, padding: "12px 0" }}>
          <button onClick={() => setSettimana(Math.max(0, settimana - 1))} disabled={settimana === 0} style={navBtn}>‹</button>
          <span style={{ fontSize: 14, fontWeight: 600, color: "#0f172a" }}>
            Settimana {settimana + 1} di {numWeeks}
          </span>
          <button onClick={() => setSettimana(Math.min(numWeeks - 1, settimana + 1))} disabled={settimana === numWeeks - 1} style={navBtn}>›</button>
        </div>
      )}

      <div style={{ overflowX: "auto", padding: "0 12px" }}>
        <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", minWidth: 620 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", position: "sticky", left: 0, background: "#f8fafc", zIndex: 2 }}>Dipendente</th>
              {giorni.map((d, i) => {
                const we = i >= 5;
                return (
                  <th key={i} style={{ ...th, background: we ? "#f1f5f9" : "#f8fafc" }}>
                    <div style={{ fontWeight: 700, color: we ? "#64748b" : "#0f172a" }}>{GIORNI[i]}</div>
                    <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 400 }}>{fmtGiorno(d)}</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id}>
                <td style={{ ...tdName, position: "sticky", left: 0, background: "#fff", zIndex: 1 }}>{e.nome || "—"}</td>
                {giorni.map((d, i) => {
                  const t = get(e.id, d);
                  const c = COLORI_TURNO[t];
                  const key = e.id + iso(d);
                  const conflitto = conflitti?.has(key);
                  return (
                    <td key={i} style={{ padding: 3 }}>
                      <button
                        onClick={() => setCella({ empId: e.id, isoDay: iso(d) })}
                        style={{
                          width: "100%", border: conflitto ? "2px solid #dc2626" : "1px solid " + c.bar + "40",
                          background: c.bg, borderRadius: 8, padding: "6px 4px", cursor: "pointer",
                          display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
                        }}
                      >
                        <span style={{ fontSize: 11, fontWeight: 700, color: c.fg }}>{TURNI[t].label}</span>
                        <span style={{ fontSize: 10, color: c.fg, opacity: 0.7 }}>{TURNI[t].orario}</span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ padding: "12px 16px 0" }}>
        <button onClick={() => esportaOrario(orario, employees, weekStart)} style={{
          ...btnPrimary, background: "#334155", marginBottom: 0, padding: 11, fontSize: 14,
        }}>⤓ Esporta orario</button>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, padding: 16, fontSize: 12, color: "#64748b" }}>
        {Object.entries({ mattina: "Mattina", "10-18": "Intermedio", sera: "Sera", libero: "Libero" }).map(([k, l]) => (
          <span key={k} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: COLORI_TURNO[k].bar }} /> {l}
          </span>
        ))}
        <span style={{ marginLeft: "auto" }}>Motore: {motore === "backend" ? "CP-SAT" : motore === "manuale" ? "creato a mano" : "locale (bozza)"}</span>
      </div>

      {cella && (
        <div onClick={() => setCella(null)} style={modalBg}>
          <div onClick={(e) => e.stopPropagation()} style={modal}>
            <div style={{ fontWeight: 600, marginBottom: 4, color: "#0f172a" }}>
              {employees.find((e) => e.id === cella.empId)?.nome}
            </div>
            <div style={{ fontSize: 13, color: "#64748b", marginBottom: 14 }}>
              {GIORNI_FULL[(new Date(cella.isoDay).getDay() + 6) % 7]} {fmtGiorno(new Date(cella.isoDay))}
            </div>
            {[...ASSEGNABILI, "libero", ...(draft ? ["-"] : [])].map((t) => (
              <button key={t} onClick={() => { onModifica(cella.empId, cella.isoDay, t); setCella(null); }}
                style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "11px 14px", marginBottom: 6, borderRadius: 10, cursor: "pointer",
                  border: "1px solid " + COLORI_TURNO[t].bar + "55", background: COLORI_TURNO[t].bg }}>
                <span style={{ fontWeight: 600, color: COLORI_TURNO[t].fg }}>{t === "-" ? "Svuota cella" : TURNI[t].label}</span>
                <span style={{ fontSize: 13, color: COLORI_TURNO[t].fg, opacity: 0.7 }}>{t === "-" ? "da impostare" : TURNI[t].orario}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ==========================================================================
//  VALIDAZIONE on-the-fly delle modifiche manuali
// ==========================================================================
function trovaConflitti(orario, employees, start, numWeeks) {
  const conflitti = new Set();
  const empById = Object.fromEntries(employees.map((e) => [e.id, e]));
  const days = Array.from({ length: numWeeks * 7 }, (_, i) => addDays(start, i));
  const get = (eid, d) => orario.find((a) => a.employee_id === eid && a.giorno === iso(d))?.turno || "libero";

  for (const d of days) {
    const mattina = employees.filter((e) => get(e.id, d) === "mattina");
    const sera = employees.filter((e) => get(e.id, d) === "sera");
    const apre = mattina.some((e) => empById[e.id].sa_aprire);
    const chiude = sera.some((e) => empById[e.id].sa_chiudere);
    if (mattina.length < 2 || !apre) mattina.forEach((e) => conflitti.add(e.id + iso(d)));
    if (sera.length < 2 || !chiude) sera.forEach((e) => conflitti.add(e.id + iso(d)));
    if (mattina.length < 2) employees.forEach((e) => { if (get(e.id, d) === "mattina") conflitti.add(e.id + iso(d)); });
    // riposo 12h
    for (const e of employees) {
      const prev = get(e.id, addDays(d, -1));
      const cur = get(e.id, d);
      if (prev !== "libero" && cur !== "libero" && restHours(prev, cur) < empById[e.id].riposo_minimo_ore) {
        conflitti.add(e.id + iso(d));
      }
    }
  }
  return conflitti;
}

// ==========================================================================
//  ANALISI della bozza manuale ("Crea orario") — avvisi a due livelli.
//  ROSSO  = violazione vera (blocca il salvataggio)
//  GIALLO = situazione consentita dalle impostazioni del dipendente (informa)
//  prevInfo = { vigilia: {empId: turno di domenica precedente},
//               tail:    {empId: giorni consecutivi lavorati fino a domenica} }
// ==========================================================================
function analizzaBozza(orario, employees, start, entries, prevInfo) {
  const rossi = [], gialli = [];
  const giorni = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const get = (eid, d) =>
    orario.find((a) => a.employee_id === eid && a.giorno === iso(d))?.turno || "-";
  const isFerie = (eid, d) =>
    entries.some((en) => en.tipo === "ferie" && en.employee_id === eid &&
      en.start <= iso(d) && iso(d) <= en.end);
  const gLabel = (d) => `${GIORNI[(d.getDay() + 6) % 7]} ${fmtGiorno(d)}`;
  const lavoro = (t) => ASSEGNABILI.includes(t);

  let daCompilare = 0;
  for (const e of employees)
    for (const d of giorni)
      if (get(e.id, d) === "-") daCompilare++;

  // --- copertura e competenze, per giorno ---
  for (const d of giorni) {
    const mat = employees.filter((e) => get(e.id, d) === "mattina");
    const ser = employees.filter((e) => get(e.id, d) === "sera");
    if (mat.length < 2)
      rossi.push(`${gLabel(d)}: ${mat.length === 0 ? "nessuna persona" : "solo 1 persona"} di mattina (minimo 2).`);
    if (ser.length < 2)
      rossi.push(`${gLabel(d)}: ${ser.length === 0 ? "nessuna persona" : "solo 1 persona"} di sera (minimo 2).`);
    if (mat.length > 0 && !mat.some((e) => e.sa_aprire))
      rossi.push(`${gLabel(d)}: nessuno dei presenti di mattina sa aprire.`);
    if (ser.length > 0 && !ser.some((e) => e.sa_chiudere))
      rossi.push(`${gLabel(d)}: nessuno dei presenti di sera sa chiudere.`);
  }

  // --- controlli per dipendente ---
  for (const e of employees) {
    const nome = e.nome || "—";

    // turno assegnato su giorno di ferie
    for (const d of giorni) {
      const t = get(e.id, d);
      if (isFerie(e.id, d) && lavoro(t))
        rossi.push(`${nome} è in ferie ${gLabel(d)} ma ha un turno assegnato.`);
    }

    // riposo tra giorni consecutivi (inclusa la domenica della settimana prima)
    const seq = [
      { d: null, t: (prevInfo.vigilia || {})[e.id] || "libero" },
      ...giorni.map((d) => ({ d, t: get(e.id, d) })),
    ];
    for (let i = 0; i < seq.length - 1; i++) {
      const a = seq[i], b = seq[i + 1];
      if (lavoro(a.t) && lavoro(b.t)) {
        const h = restHours(a.t, b.t);
        const labelA = a.d ? gLabel(a.d) : "la domenica precedente";
        if (h < e.riposo_minimo_ore)
          rossi.push(`${nome}: solo ${h} ore di riposo tra ${labelA} e ${gLabel(b.d)} (il suo minimo è ${e.riposo_minimo_ore}).`);
        else if (h < 12)
          gialli.push(`${nome}: riposo ridotto (${h} ore) tra ${labelA} e ${gLabel(b.d)} — consentito dalle sue impostazioni.`);
      }
    }

    // giorni liberi (valutati solo a riga completa, per evitare falsi allarmi)
    const disp = giorni.filter((d) => !isFerie(e.id, d));
    if (disp.length > 0 && disp.every((d) => get(e.id, d) !== "-")) {
      const nLib = disp.filter((d) => get(e.id, d) === "libero").length;
      if (nLib === 0)
        rossi.push(`${nome} non ha nessun giorno libero questa settimana.`);
      else if (nLib === 1 && disp.length >= 2) {
        if (e.libero_sacrificabile)
          gialli.push(`${nome} ha un solo giorno libero — consentito dalle sue impostazioni (libero sacrificabile).`);
        else
          rossi.push(`${nome} ha un solo giorno libero e non ha il "libero sacrificabile" attivo.`);
      } else if (nLib > 2)
        gialli.push(`${nome} ha ${nLib} giorni liberi (di norma il massimo è 2).`);
    }

    // giorni di lavoro consecutivi (contando la coda della settimana precedente)
    let run = (prevInfo.tail || {})[e.id] || 0;
    let maxRun = 0;
    for (const d of giorni) {
      if (lavoro(get(e.id, d))) { run++; if (run > maxRun) maxRun = run; }
      else run = 0;
    }
    if (maxRun >= 7)
      rossi.push(`${nome} arriva a ${maxRun} giorni di lavoro consecutivi (contando anche la settimana precedente).`);
    else if (maxRun === 6)
      gialli.push(`${nome} arriva a 6 giorni di lavoro consecutivi.`);
  }

  return { rossi, gialli, daCompilare };
}

// ==========================================================================
//  ESPORTA ORARIO — immagine JPG orizzontale della settimana visualizzata.
//  Disegno su canvas nativo: nessuna libreria esterna, funziona offline.
// ==========================================================================
function esportaOrario(orario, employees, weekStart) {
  const giorni = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const get = (eid, d) =>
    orario.find((a) => a.employee_id === eid && a.giorno === iso(d))?.turno || "libero";

  // geometria (px logici, scala 2x per nitidezza)
  const SCALA = 2;
  const W = 1600;
  const M = 40;                 // margine esterno
  const TITOLO_H = 64;
  const HEADER_H = 56;
  const RIGA_H = employees.length <= 7 ? 88 : Math.max(56, Math.floor(620 / employees.length));
  const NOME_W = 230;
  const H = M + TITOLO_H + HEADER_H + RIGA_H * employees.length + M;
  const COL_W = (W - 2 * M - NOME_W) / 7;

  const canvas = document.createElement("canvas");
  canvas.width = W * SCALA;
  canvas.height = H * SCALA;
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALA, SCALA);
  const FONT = "-apple-system, system-ui, sans-serif";

  const rr = (x, y, w, h, r) => {   // rettangolo arrotondato (compatibile ovunque)
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };

  // sfondo
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // titolo
  const dom = giorni[6];
  ctx.fillStyle = "#0f172a";
  ctx.font = `700 30px ${FONT}`;
  ctx.textBaseline = "middle";
  ctx.fillText(
    `Turni — settimana ${weekStart.getDate()}/${weekStart.getMonth() + 1} – ${dom.getDate()}/${dom.getMonth() + 1}/${dom.getFullYear()}`,
    M, M + TITOLO_H / 2 - 6
  );

  // colonne weekend leggermente evidenziate
  for (let i = 5; i < 7; i++) {
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(M + NOME_W + i * COL_W, M + TITOLO_H, COL_W, HEADER_H + RIGA_H * employees.length);
  }

  // intestazione giorni
  ctx.textAlign = "center";
  giorni.forEach((d, i) => {
    const cx = M + NOME_W + i * COL_W + COL_W / 2;
    ctx.fillStyle = i >= 5 ? "#64748b" : "#0f172a";
    ctx.font = `700 20px ${FONT}`;
    ctx.fillText(GIORNI[i], cx, M + TITOLO_H + 20);
    ctx.fillStyle = "#94a3b8";
    ctx.font = `400 16px ${FONT}`;
    ctx.fillText(fmtGiorno(d), cx, M + TITOLO_H + 42);
  });

  // righe dipendenti
  employees.forEach((e, r) => {
    const y = M + TITOLO_H + HEADER_H + r * RIGA_H;
    // separatore
    ctx.strokeStyle = "#f1f5f9";
    ctx.beginPath(); ctx.moveTo(M, y); ctx.lineTo(W - M, y); ctx.stroke();
    // nome
    ctx.textAlign = "left";
    ctx.fillStyle = "#0f172a";
    ctx.font = `600 20px ${FONT}`;
    ctx.fillText(e.nome || "—", M + 6, y + RIGA_H / 2, NOME_W - 16);
    // celle
    giorni.forEach((d, i) => {
      const t = get(e.id, d);
      const c = COLORI_TURNO[t] || COLORI_TURNO["libero"];
      const x = M + NOME_W + i * COL_W;
      rr(x + 5, y + 7, COL_W - 10, RIGA_H - 14, 10);
      ctx.fillStyle = c.bg; ctx.fill();
      ctx.strokeStyle = c.bar; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.lineWidth = 1;
      ctx.textAlign = "center";
      ctx.fillStyle = c.fg;
      if (t === "libero" || t === "-") {
        ctx.font = `700 22px ${FONT}`;
        ctx.fillText("—", x + COL_W / 2, y + RIGA_H / 2);
      } else {
        ctx.font = `700 21px ${FONT}`;
        ctx.fillText(TURNI[t].orario, x + COL_W / 2, y + RIGA_H / 2 - 9);
        ctx.font = `500 14px ${FONT}`;
        ctx.fillText(TURNI[t].label, x + COL_W / 2, y + RIGA_H / 2 + 15);
      }
    });
  });

  // legenda in basso a destra
  ctx.textAlign = "right";
  ctx.fillStyle = "#94a3b8";
  ctx.font = `400 13px ${FONT}`;
  ctx.fillText("Generato dall'app Turni", W - M, H - M / 2);

  // scarica come JPG
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `orario-${iso(weekStart)}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, "image/jpeg", 0.92);
}

// ==========================================================================
//  APP
// ==========================================================================
// ==========================================================================
//  TAB STORICO — elenco orari passati, selezionabili per settimana
// ==========================================================================
function TabStorico({ storico, persistenza, onApri }) {
  if (!persistenza) {
    return <div style={empty}>Lo storico richiede il salvataggio sul server, che non risulta attivo al momento.</div>;
  }
  if (!storico || storico.length === 0) {
    return <div style={empty}>Nessun orario salvato finora. Genera un orario: verrà archiviato qui automaticamente.</div>;
  }
  // raggruppa per mese
  const fmt = (isoStr) => {
    const [y, m, d] = isoStr.split("-").map(Number);
    return `${d}/${m}/${y}`;
  };
  // range settimana: dal lunedì (data_inizio) alla domenica (+6 giorni)
  const rangeSettimana = (isoStr) => {
    const [y, m, d] = isoStr.split("-").map(Number);
    const lun = new Date(y, m - 1, d);
    const dom = new Date(lun);
    dom.setDate(dom.getDate() + 6);
    const gg = (dt) => `${dt.getDate()}/${dt.getMonth() + 1}`;
    return `${gg(lun)} – ${gg(dom)}`;
  };
  const meseLabel = (isoStr) => {
    const [y, m] = isoStr.split("-").map(Number);
    return `${["Gen","Feb","Mar","Apr","Mag","Giu","Lug","Ago","Set","Ott","Nov","Dic"][m-1]} ${y}`;
  };
  const gruppi = {};
  for (const s of storico) {
    const k = meseLabel(s.data_inizio);
    (gruppi[k] = gruppi[k] || []).push(s);
  }
  return (
    <div style={{ padding: 16, paddingBottom: 40 }}>
      {Object.entries(gruppi).map(([mese, lista]) => (
        <div key={mese} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>{mese}</div>
          {lista.map((s) => (
            <button key={s.id} onClick={() => onApri(s)} style={{
              width: "100%", textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center",
              background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "13px 14px", marginBottom: 8, cursor: "pointer",
            }}>
              <div>
                <div style={{ fontSize: 14.5, fontWeight: 600, color: "#0f172a" }}>
                  Settimana dal {rangeSettimana(s.data_inizio)}
                </div>
                <div style={{ fontSize: 12, color: "#64748b" }}>
                  {s.stato === "OPTIMAL" ? "completo" : s.stato.toLowerCase()}
                </div>
              </div>
              <span style={{ color: "#94a3b8", fontSize: 18 }}>›</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

// ==========================================================================
//  ORARIO FULLSCREEN (landscape) — solo la griglia, a tutto schermo
// ==========================================================================
function OrarioFullscreen({ orario, employees, start, numWeeks, conflitti, onModifica, onExit }) {
  const [settimana, setSettimana] = useState(0);
  const [cella, setCella] = useState(null);

  const weekStart = addDays(start, settimana * 7);
  const giorni = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const get = (empId, d) =>
    orario.find((a) => a.employee_id === empId && a.giorno === iso(d))?.turno || "libero";

  return (
    <div style={{ position: "fixed", inset: 0, background: "#fff", display: "flex", flexDirection: "column", zIndex: 1000, fontFamily: "-apple-system, system-ui, sans-serif" }}>
      {/* griglia che riempie tutto lo schermo */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {/* intestazione: cella d'angolo con tasto Esci + giorni compatti */}
        <div style={{ display: "flex", flexShrink: 0, borderBottom: "2px solid #e2e8f0" }}>
          <div style={{ width: "13%", padding: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <button onClick={onExit} style={{
              width: "100%", height: "100%", minHeight: 40, background: "#0f172a", color: "#fff",
              border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 700,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
            }}>✕ Esci</button>
          </div>
          {giorni.map((d, i) => {
            const we = i >= 5;
            return (
              <div key={i} style={{ flex: 1, padding: "6px 2px", textAlign: "center", background: we ? "#f1f5f9" : "#f8fafc", borderLeft: "1px solid #e2e8f0", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: we ? "#64748b" : "#0f172a" }}>{GIORNI[i]}</span>
                <span style={{ fontSize: 10.5, color: "#94a3b8" }}>{fmtGiorno(d)}</span>
              </div>
            );
          })}
        </div>
        {/* righe dipendenti */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {employees.map((e) => (
            <div key={e.id} style={{ flex: 1, display: "flex", borderBottom: "1px solid #f1f5f9", minHeight: 0 }}>
              <div style={{ width: "13%", padding: "0 8px", fontSize: 13, fontWeight: 600, color: "#0f172a", display: "flex", alignItems: "center", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                {e.nome}
              </div>
              {giorni.map((d, i) => {
                const t = get(e.id, d);
                const c = COLORI_TURNO[t];
                const conflitto = conflitti?.has(e.id + iso(d));
                return (
                  <button key={i} onClick={() => setCella({ empId: e.id, isoDay: iso(d) })}
                    style={{
                      flex: 1, margin: 3, borderRadius: 8,
                      border: conflitto ? "2px solid #dc2626" : "1px solid " + c.bar + "40",
                      background: c.bg, cursor: "pointer", display: "flex",
                      alignItems: "center", justifyContent: "center", padding: 0, minHeight: 0,
                    }}>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: c.fg, lineHeight: 1 }}>
                      {t === "libero" ? "—" : t === "-" ? "-" : TURNI[t].orario}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {cella && (
        <div onClick={() => setCella(null)} style={modalBgCentro}>
          <div onClick={(e) => e.stopPropagation()} style={modalCentro}>
            <div style={{ fontWeight: 600, marginBottom: 4, color: "#0f172a" }}>
              {employees.find((e) => e.id === cella.empId)?.nome}
            </div>
            <div style={{ fontSize: 13, color: "#64748b", marginBottom: 14 }}>
              {GIORNI_FULL[(new Date(cella.isoDay).getDay() + 6) % 7]} {fmtGiorno(new Date(cella.isoDay))}
            </div>
            {[...ASSEGNABILI, "libero"].map((t) => (
              <button key={t} onClick={() => { onModifica(cella.empId, cella.isoDay, t); setCella(null); }}
                style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "11px 14px", marginBottom: 6, borderRadius: 10, cursor: "pointer",
                  border: "1px solid " + COLORI_TURNO[t].bar + "55", background: COLORI_TURNO[t].bg }}>
                <span style={{ fontWeight: 600, color: COLORI_TURNO[t].fg }}>{TURNI[t].label}</span>
                <span style={{ fontSize: 13, color: COLORI_TURNO[t].fg, opacity: 0.7 }}>{TURNI[t].orario}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ==========================================================================
//  TAB STATISTICHE — turni e ferie per dipendente, attivi + archivio
// ==========================================================================
function calcolaPeriodo(scelta) {
  // ritorna [startIso, endIso] in base alla scelta del menù
  const oggi = new Date();
  const end = iso(oggi);
  let start = new Date(oggi);
  if (scelta === "1m") start.setMonth(start.getMonth() - 1);
  else if (scelta === "3m") start.setMonth(start.getMonth() - 3);
  else if (scelta === "6m") start.setMonth(start.getMonth() - 6);
  else if (scelta === "12m") start.setFullYear(start.getFullYear() - 1);
  else if (scelta === "anno") start = new Date(oggi.getFullYear(), 0, 1);
  return [iso(start), end];
}

function TabStatistiche({ persistenza }) {
  const [periodo, setPeriodo] = useState("3m");
  const [dataInizio, setDataInizio] = useState("");
  const [dataFine, setDataFine] = useState("");
  const [stats, setStats] = useState(null);
  const [emps, setEmps] = useState([]);
  const [anno, setAnno] = useState(new Date().getFullYear());
  const [ferie, setFerie] = useState({});
  const [anniFerie, setAnniFerie] = useState([]);
  const [caricamento, setCaricamento] = useState(false);

  // carica statistiche turni quando cambia il periodo
  useEffect(() => {
    if (!persistenza) return;
    let annullato = false;
    (async () => {
      setCaricamento(true);
      let startIso, endIso;
      if (periodo === "custom") {
        if (!dataInizio || !dataFine) { setCaricamento(false); return; }
        startIso = dataInizio; endIso = dataFine;
      } else {
        [startIso, endIso] = calcolaPeriodo(periodo);
      }
      try {
        const d = await caricaStatistiche(startIso, endIso);
        if (annullato) return;
        setStats(d.stats || {});
        setEmps(d.employees || []);
      } catch { /* ignora */ }
      setCaricamento(false);
    })();
    return () => { annullato = true; };
  }, [periodo, dataInizio, dataFine, persistenza]);

  // carica ferie quando cambia l'anno
  useEffect(() => {
    if (!persistenza) return;
    let annullato = false;
    (async () => {
      try {
        const d = await caricaStatisticheFerie(anno);
        if (annullato) return;
        setFerie(d.ferie || {});
        setAnniFerie(d.anni || []);
      } catch { /* ignora */ }
    })();
    return () => { annullato = true; };
  }, [anno, persistenza]);

  if (!persistenza) {
    return <div style={empty}>Le statistiche richiedono il collegamento al server, che non risulta attivo al momento.</div>;
  }

  const attivi = emps.filter((e) => !e.archiviato);
  const archiviati = emps.filter((e) => e.archiviato);

  const RigaStat = ({ e }) => {
    const s = (stats && stats[e.id]) || { mattine: 0, sere: 0, intermedi: 0, weekend: 0, liberi: 0 };
    return (
      <div style={{ display: "flex", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #f1f5f9" }}>
        <div style={{ flex: "0 0 30%", fontSize: 13.5, fontWeight: 600, color: "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", paddingRight: 6 }}>{e.nome}</div>
        <div style={statCell}>{s.mattine}</div>
        <div style={statCell}>{s.sere}</div>
        <div style={statCell}>{s.intermedi}</div>
        <div style={statCell}>{s.weekend}</div>
        <div style={statCell}>{s.liberi}</div>
      </div>
    );
  };

  return (
    <div style={{ padding: 16, paddingBottom: 40 }}>
      {/* selettore periodo turni */}
      <label style={lbl}>Periodo turni</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {[["1m","1 mese"],["3m","3 mesi"],["6m","6 mesi"],["12m","12 mesi"],["anno","Inizio anno"],["custom","Intervallo"]].map(([v,l]) => (
          <button key={v} onClick={() => setPeriodo(v)} style={chip(periodo === v)}>{l}</button>
        ))}
      </div>
      {periodo === "custom" && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={{ ...lbl, marginTop: 0 }}>Da</label>
            <input type="date" style={inp} value={dataInizio} onChange={(e) => setDataInizio(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ ...lbl, marginTop: 0 }}>A</label>
            <input type="date" style={inp} value={dataFine} onChange={(e) => setDataFine(e.target.value)} />
          </div>
        </div>
      )}

      {/* intestazione colonne */}
      <div style={{ display: "flex", alignItems: "center", padding: "8px 0", borderBottom: "2px solid #e2e8f0", marginTop: 4 }}>
        <div style={{ flex: "0 0 30%", fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase" }}>Dipendente</div>
        <div style={statHead}>Matt</div>
        <div style={statHead}>Sere</div>
        <div style={statHead}>Inter</div>
        <div style={statHead}>WE</div>
        <div style={statHead}>Liberi</div>
      </div>

      {caricamento && <div style={{ fontSize: 12.5, color: "#94a3b8", padding: "10px 0" }}>Caricamento…</div>}

      {attivi.length === 0 && !caricamento && (
        <div style={{ fontSize: 13, color: "#94a3b8", padding: "16px 0" }}>Nessun dato per il periodo selezionato.</div>
      )}
      {attivi.map((e) => <RigaStat key={e.id} e={e} />)}

      {/* archivio */}
      {archiviati.length > 0 && (
        <>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, margin: "22px 0 4px" }}>Archivio</div>
          <div style={{ fontSize: 11.5, color: "#94a3b8", marginBottom: 8 }}>Dipendenti non più attivi — dati conservati.</div>
          <div style={{ display: "flex", alignItems: "center", padding: "8px 0", borderBottom: "2px solid #e2e8f0" }}>
            <div style={{ flex: "0 0 30%", fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase" }}>Dipendente</div>
            <div style={statHead}>Matt</div><div style={statHead}>Sere</div><div style={statHead}>Inter</div><div style={statHead}>WE</div><div style={statHead}>Liberi</div>
          </div>
          {archiviati.map((e) => <RigaStat key={e.id} e={e} />)}
        </>
      )}

      {/* ferie per anno */}
      <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, margin: "28px 0 8px" }}>Ferie per anno solare</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <button onClick={() => setAnno(anno - 1)} style={navBtn}>‹</button>
        <span style={{ fontSize: 16, fontWeight: 700, color: "#0f172a", minWidth: 56, textAlign: "center" }}>{anno}</span>
        <button onClick={() => setAnno(anno + 1)} style={navBtn}>›</button>
      </div>
      <div>
        {emps.map((e) => (
          <div key={e.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "1px solid #f1f5f9" }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, color: e.archiviato ? "#94a3b8" : "#0f172a" }}>
              {e.nome}{e.archiviato ? " (archivio)" : ""}
            </span>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#0f172a" }}>
              {ferie[e.id] || 0} <span style={{ fontSize: 12, fontWeight: 400, color: "#94a3b8" }}>giorni</span>
            </span>
          </div>
        ))}
        {emps.length === 0 && <div style={{ fontSize: 13, color: "#94a3b8", padding: "10px 0" }}>Nessun dato.</div>}
      </div>
    </div>
  );
}

const statCell = { flex: 1, textAlign: "center", fontSize: 13.5, color: "#0f172a", fontVariantNumeric: "tabular-nums" };
const statHead = { flex: 1, textAlign: "center", fontSize: 10.5, fontWeight: 700, color: "#64748b", textTransform: "uppercase" };

// ==========================================================================
//  SINCRONIZZAZIONE COL BACKEND (persistenza Supabase via Render)
// ==========================================================================
const BACKEND = "https://orari-buono.onrender.com";

// --------------------------------------------------------------------------
//  SALVATAGGIO LOCALE (localStorage) — mostra subito l'ultimo stato all'avvio
//  senza attendere il cloud. Dipendenti e calendario; lo storico resta sul cloud.
// --------------------------------------------------------------------------
const LS_EMP = "turni_employees";
const LS_CAL = "turni_calendar";

function leggiLocale(chiave) {
  try {
    const raw = localStorage.getItem(chiave);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function scriviLocale(chiave, valore) {
  try {
    localStorage.setItem(chiave, JSON.stringify(valore));
  } catch {
    // storage pieno o non disponibile: ignora silenziosamente
  }
}

async function api(path, options) {
  const r = await fetch(BACKEND.replace(/\/$/, "") + path, options);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function caricaDipendenti() {
  const d = await api("/dipendenti");
  // normalizza turni_fissi: il DB restituisce chiavi stringa, le teniamo tali
  return d.employees || [];
}
async function salvaDipendenti(employees) {
  return api("/dipendenti", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ employees }),
  });
}
async function caricaCalendario() {
  const d = await api("/calendario");
  return d.entries || [];
}
async function salvaCalendario(entries) {
  return api("/calendario", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  });
}
async function caricaStorico() {
  const d = await api("/storico");
  return d.schedules || [];
}
async function caricaOrarioSalvato(startIso, weeks) {
  const d = await api(`/orario?start=${startIso}&weeks=${weeks}`);
  return d.assignments || [];
}
async function modificaTurno(employee_id, giorno, turno) {
  return api("/modifica", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ employee_id, giorno, turno }),
  });
}
async function caricaStatistiche(startIso, endIso) {
  const d = await api(`/statistiche?start=${startIso}&end=${endIso}`);
  return d;  // { stats, employees }
}
async function caricaStatisticheFerie(anno) {
  const d = await api(`/statistiche-ferie?anno=${anno}`);
  return d;  // { ferie, anni }
}

// normalizza un dipendente caricato dal DB (turni_fissi con chiavi stringa)
function normEmp(e) {
  const tf = {};
  for (const [k, v] of Object.entries(e.turni_fissi || {})) tf[Number(k)] = v;
  return { ...e, turni_fissi: tf, giorni_liberi_fissi: e.giorni_liberi_fissi || [] };
}

// ==========================================================================
//  APP
// ==========================================================================
export default function App() {
  const [tab, setTab] = useState("dipendenti");
  const [employees, setEmployees] = useState(() => leggiLocale(LS_EMP) || seedEmployees());
  const [entries, setEntries] = useState(() => leggiLocale(LS_CAL) || []);
  const [numWeeks, setNumWeeks] = useState(1);
  const [start, setStart] = useState(lunediProssimo());
  const [assenze, setAssenze] = useState([]);  // [{employee_id, giorni:Set<iso>}] usa-e-getta per la generazione
  const [presenze, setPresenze] = useState([]); // [{employee_id, giorni:{iso:turno}}] presenze obbligate usa-e-getta
  const [bozzaManuale, setBozzaManuale] = useState(false); // true = "Crea orario" in corso
  const [salvataggioBozza, setSalvataggioBozza] = useState(false);
  const [prevInfo, setPrevInfo] = useState({ vigilia: {}, tail: {} }); // settimana precedente (per riposo/consecutivi)
  const [conferma, setConferma] = useState(null); // {titolo, testo, cta, onConferma} — modale di conferma
  const [orario, setOrario] = useState(null);
  const [messaggi, setMessaggi] = useState([]);
  const [violazioni, setViolazioni] = useState([]);
  const [motore, setMotore] = useState("locale");
  const [loading, setLoading] = useState(false);
  const [storico, setStorico] = useState([]);
  const [settimanaStorica, setSettimanaStorica] = useState(null);  // se attivo, naviga lo storico a frecce
  const [persistenza, setPersistenza] = useState(false);
  const [syncMsg, setSyncMsg] = useState("Connessione al server…");
  const [landscape, setLandscape] = useState(false);
  const [pronto, setPronto] = useState(false);
  const backendUrl = BACKEND;

  // --- Caricamento iniziale dal backend ---
  useEffect(() => {
    let annullato = false;
    (async () => {
      try {
        const stato = await api("/stato");
        if (annullato) return;
        if (stato.persistenza) {
          setPersistenza(true);
          const [emps, cal, stor] = await Promise.all([
            caricaDipendenti(), caricaCalendario(), caricaStorico(),
          ]);
          if (annullato) return;
          // Il cloud vince sempre: sovrascrive il locale (che era gia' mostrato
          // all'avvio per evitare il lampeggio). Aggiorniamo anche il locale.
          const empNorm = emps.map(normEmp);
          setEmployees(empNorm);
          scriviLocale(LS_EMP, empNorm);
          setEntries(cal);
          scriviLocale(LS_CAL, cal);
          setStorico(stor);
          setSyncMsg("");
        } else {
          setSyncMsg("Server senza database: i dati restano solo su questo telefono.");
        }
      } catch (e) {
        if (!annullato) setSyncMsg("Server non raggiungibile (potrebbe risvegliarsi tra ~1 min).");
      } finally {
        if (!annullato) setPronto(true);
      }
    })();
    return () => { annullato = true; };
  }, []);

  // --- Salvataggio dipendenti: locale subito + cloud automatico (debounce) ---
  useEffect(() => {
    scriviLocale(LS_EMP, employees);
    if (!persistenza || !pronto) return;
    const t = setTimeout(() => { salvaDipendenti(employees).catch(() => {}); }, 800);
    return () => clearTimeout(t);
  }, [employees, persistenza, pronto]);

  // --- Salvataggio calendario: locale subito + cloud automatico (debounce) ---
  useEffect(() => {
    scriviLocale(LS_CAL, entries);
    if (!persistenza || !pronto) return;
    const t = setTimeout(() => { salvaCalendario(entries).catch(() => {}); }, 800);
    return () => clearTimeout(t);
  }, [entries, persistenza, pronto]);

  const conflitti = useMemo(
    () => (orario ? trovaConflitti(orario, employees, start, numWeeks) : new Set()),
    [orario, employees, start, numWeeks]
  );

  // analisi in tempo reale della bozza manuale (avvisi rosso/giallo)
  const avvisiBozza = useMemo(
    () => (bozzaManuale && orario ? analizzaBozza(orario, employees, start, entries, prevInfo) : null),
    [bozzaManuale, orario, employees, start, entries, prevInfo]
  );

  const eseguiGenera = async () => {
    setLoading(true);
    setMessaggi([]);
    setSettimanaStorica(null);  // un orario appena generato non e' navigazione storica
    setBozzaManuale(false);
    // le assenze (usa-e-getta) diventano entry tipo "assenza" con start==end per ogni giorno
    const entryAssenze = [];
    for (const a of assenze) {
      for (const g of a.giorni) {
        entryAssenze.push({ tipo: "assenza", employee_id: a.employee_id, start: g, end: g });
      }
    }
    // le presenze obbligate (usa-e-getta) diventano entry "turno_obbligato";
    // il turno imposto viaggia nel campo turno_preferito
    for (const p of presenze) {
      for (const [g, t] of Object.entries(p.giorni)) {
        entryAssenze.push({ tipo: "turno_obbligato", employee_id: p.employee_id, start: g, end: g, turno_preferito: t });
      }
    }
    const entriesConAssenze = [...entries, ...entryAssenze];
    const res = await generaOrario(employees, entriesConAssenze, start, numWeeks, storico, backendUrl);
    setOrario(res.assignments);
    setMessaggi(res.messaggi || []);
    setViolazioni(res.violazioni || []);
    setMotore(res.motore);
    setLoading(false);
    setTab("orario");
    setAssenze([]);   // usa e getta: si azzerano dopo la generazione
    setPresenze([]);
    // ricarica lo storico (la generazione lo ha aggiornato lato server)
    if (persistenza) caricaStorico().then(setStorico).catch(() => {});
  };

  const genera = () => {
    // avviso se una o piu' settimane da generare esistono gia' nello storico
    const target = Array.from({ length: numWeeks }, (_, w) => iso(addDays(start, w * 7)));
    const esistenti = target.filter((t) => storico.some((s) => s.data_inizio === t));
    if (esistenti.length > 0) {
      const el = esistenti.map((t) => { const [y, m, d] = t.split("-").map(Number); return `${d}/${m}`; }).join(", ");
      setConferma({
        titolo: "Settimane già presenti",
        testo: esistenti.length === 1
          ? `L'orario della settimana dal ${el} esiste già nello storico: generando di nuovo verrà sovrascritto.`
          : `Gli orari delle settimane dal ${el} esistono già nello storico: generando di nuovo verranno sovrascritti.`,
        cta: "Genera e sovrascrivi",
        onConferma: eseguiGenera,
      });
      return;
    }
    eseguiGenera();
  };

  const modifica = (empId, isoDay, turno) => {
    setOrario((prev) =>
      prev.map((a) => (a.employee_id === empId && a.giorno === isoDay ? { ...a, turno } : a))
    );
    // in bozza manuale niente salvataggio immediato: si salva solo con Conferma
    if (persistenza && !bozzaManuale) modificaTurno(empId, isoDay, turno).catch(() => {});
  };

  // --- "Crea orario": settimana vuota da comporre a mano ---
  const creaManuale = async () => {
    const giorni = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const inFerie = (eid, d) =>
      entries.some((en) => en.tipo === "ferie" && en.employee_id === eid &&
        en.start <= iso(d) && iso(d) <= en.end);
    const bozza = [];
    for (const e of employees)
      for (const d of giorni)
        bozza.push({ employee_id: e.id, giorno: iso(d), turno: inFerie(e.id, d) ? "libero" : "-" });
    setOrario(bozza);
    setBozzaManuale(true);
    setSettimanaStorica(null);
    setNumWeeks(1);
    setMessaggi([]);
    setViolazioni([]);
    setMotore("manuale");
    setTab("orario");
    // coda e vigilia della settimana precedente (se salvata), per gli avvisi
    // su riposo e giorni consecutivi a cavallo delle settimane
    let info = { vigilia: {}, tail: {} };
    if (persistenza) {
      try {
        const prevAss = await caricaOrarioSalvato(iso(addDays(start, -7)), 1);
        if (prevAss && prevAss.length) {
          const get = (eid, dIso) => prevAss.find((a) => a.employee_id === eid && a.giorno === dIso)?.turno;
          for (const e of employees) {
            info.vigilia[e.id] = get(e.id, iso(addDays(start, -1))) || "libero";
            let t = 0;
            for (let i = 1; i <= 7; i++) {
              const tu = get(e.id, iso(addDays(start, -i)));
              if (tu && tu !== "libero") t++; else break;
            }
            info.tail[e.id] = t;
          }
        }
      } catch { /* senza storico: si valuta solo la settimana */ }
    }
    setPrevInfo(info);
  };

  const annullaManuale = () => {
    setConferma({
      titolo: "Uscire senza salvare?",
      testo: "L'orario che stai creando a mano andrà perso.",
      cta: "Esci",
      onConferma: () => { setBozzaManuale(false); setOrario(null); setMotore("locale"); },
    });
  };

  const salvaManuale = () => {
    if (!avvisiBozza || avvisiBozza.rossi.length > 0 || avvisiBozza.daCompilare > 0) return;
    const esegui = async () => {
      setSalvataggioBozza(true);
      try {
        await api("/salva-orario", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ start: iso(start), assignments: orario }),
        });
        setBozzaManuale(false);
        setSettimanaStorica(iso(start));
        setMessaggi([]);
        const stor = await caricaStorico();
        setStorico(stor);
      } catch (e) {
        setMessaggi(["Salvataggio non riuscito: server non raggiungibile. Se era inattivo, attendi ~1 minuto e riprova."]);
      }
      setSalvataggioBozza(false);
    };
    const esiste = storico.some((s) => s.data_inizio === iso(start));
    if (esiste) {
      setConferma({
        titolo: "Settimana già presente",
        testo: `L'orario della settimana dal ${fmtGiorno(start)} esiste già nello storico: salvando verrà sovrascritto.`,
        cta: "Sovrascrivi",
        onConferma: esegui,
      });
    } else {
      esegui();
    }
  };

  // carica un orario storico selezionato
  const apriStorico = async (sched) => {
    const [y, m, d] = sched.data_inizio.split("-").map(Number);
    const s = new Date(y, m - 1, d);
    setBozzaManuale(false);  // aprire lo storico chiude un'eventuale bozza manuale
    setStart(s);
    setNumWeeks(1);  // nel nuovo modello ogni voce e' una singola settimana
    setSettimanaStorica(sched.data_inizio);  // attiva la navigazione a frecce
    try {
      const assigns = await caricaOrarioSalvato(sched.data_inizio, 1);
      setOrario(assigns);
      setMotore("backend");
      setMessaggi([]);
      setViolazioni([]);
      setTab("orario");
    } catch (e) {
      setMessaggi(["Impossibile caricare l'orario storico."]);
    }
  };

  // naviga alla settimana storica precedente/successiva (tra tutte quelle salvate)
  const navigaSettimana = async (direzione) => {
    if (!settimanaStorica || !storico || storico.length === 0) return;
    // ordina le settimane salvate per data crescente
    const ordinate = [...storico].sort((a, b) => a.data_inizio.localeCompare(b.data_inizio));
    const idx = ordinate.findIndex((s) => s.data_inizio === settimanaStorica);
    if (idx < 0) return;
    const nuovo = ordinate[idx + direzione];
    if (!nuovo) return;  // non c'e' una settimana in quella direzione
    await apriStorico(nuovo);
  };
  // info per le frecce: esiste precedente/successiva?
  const navInfo = (() => {
    if (!settimanaStorica || !storico || storico.length === 0) return null;
    const ordinate = [...storico].sort((a, b) => a.data_inizio.localeCompare(b.data_inizio));
    const idx = ordinate.findIndex((s) => s.data_inizio === settimanaStorica);
    if (idx < 0) return null;
    return { haPrec: idx > 0, haSucc: idx < ordinate.length - 1, corrente: settimanaStorica };
  })();

  // Vista landscape fullscreen: solo la tabella, niente UI attorno.
  if (landscape && orario) {
    return (
      <OrarioFullscreen
        orario={orario} employees={employees} start={start} numWeeks={numWeeks}
        conflitti={conflitti} onModifica={modifica} onExit={() => setLandscape(false)}
      />
    );
  }

  return (
    <div style={{ fontFamily: "-apple-system, system-ui, sans-serif", background: "#f1f5f9", minHeight: "100vh", color: "#0f172a" }}>
      <header style={{ background: "#0f172a", color: "#fff", padding: "16px 18px 14px" }}>
        <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: -0.3 }}>Turni</div>
        <div style={{ fontSize: 12.5, color: "#94a3b8" }}>
          {employees.length} dipendenti · {numWeeks} {numWeeks === 1 ? "settimana" : "settimane"} · dal {fmtGiorno(start)}
          {persistenza ? " · salvato ☁" : ""}
        </div>
      </header>

      {syncMsg && (
        <div style={{ background: "#fff7ed", color: "#9a3412", fontSize: 12.5, padding: "8px 16px", borderBottom: "1px solid #fed7aa" }}>
          {syncMsg}
        </div>
      )}

      <nav style={{ display: "flex", background: "#fff", borderBottom: "1px solid #e2e8f0", position: "sticky", top: 0, zIndex: 10 }}>
        {[["dipendenti", "Dipendenti"], ["calendario", "Calendario"], ["orario", "Orario"], ["storico", "Storico"], ["statistiche", "Stat."]].map(([v, l]) => (
          <button key={v} onClick={() => setTab(v)} style={{
            flex: 1, padding: "13px 0", border: "none", background: "none", cursor: "pointer",
            fontSize: 12.5, fontWeight: tab === v ? 700 : 500, color: tab === v ? "#0f172a" : "#94a3b8",
            borderBottom: tab === v ? "2px solid #0f172a" : "2px solid transparent",
          }}>{l}</button>
        ))}
      </nav>

      <main>
        {tab === "dipendenti" && <TabDipendenti employees={employees} setEmployees={setEmployees} />}
        {tab === "calendario" && (
          <>
            <div style={{ padding: "16px 16px 0" }}>
              <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e2e8f0", padding: 16 }}>
                <label style={lbl}>Lunedì di partenza</label>
                <input type="date" style={inp} value={iso(start)} min={iso(lunediProssimo())}
                  onChange={(e) => {
                    if (!e.target.value) return;
                    const [y, m, d] = e.target.value.split("-").map(Number);
                    const picked = new Date(y, m - 1, d);
                    // forza al lunedì della settimana scelta
                    const wd = (picked.getDay() + 6) % 7;
                    picked.setDate(picked.getDate() - wd);
                    // blocca le settimane passate o correnti: minimo il lunedì prossimo
                    const minimo = lunediProssimo();
                    setStart(picked < minimo ? minimo : picked);
                  }} />
                <div style={{ fontSize: 12, color: "#64748b", marginTop: -2, marginBottom: 4 }}>
                  L'orario partirà dal lunedì {fmtGiorno(start)}. La settimana corrente non è generabile.
                </div>
                <label style={lbl}>Periodo da pianificare</label>
                <div style={{ display: "flex", gap: 6 }}>
                  {[1, 2, 3, 4].map((w) => (
                    <button key={w} onClick={() => setNumWeeks(w)} style={chip(numWeeks === w)}>{w} sett.</button>
                  ))}
                </div>

                <SelettoreAssenze employees={employees} assenze={assenze} setAssenze={setAssenze}
                  start={start} numWeeks={numWeeks} />

                <SelettorePresenze employees={employees} presenze={presenze} setPresenze={setPresenze}
                  start={start} numWeeks={numWeeks} />
              </div>
            </div>
            <TabCalendario employees={employees} entries={entries} setEntries={setEntries} start={start} numWeeks={numWeeks} />
          </>
        )}
        {tab === "orario" && (
          <>
            {orario && navInfo && (
              <div style={{ padding: "12px 16px 0" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                  background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "10px 12px" }}>
                  <button onClick={() => navigaSettimana(-1)} disabled={!navInfo.haPrec} style={{
                    width: 40, height: 40, borderRadius: 10, border: "1px solid #e2e8f0", cursor: navInfo.haPrec ? "pointer" : "default",
                    background: navInfo.haPrec ? "#f8fafc" : "#f1f5f9", color: navInfo.haPrec ? "#0f172a" : "#cbd5e1", fontSize: 20, lineHeight: 1,
                  }}>‹</button>
                  <div style={{ textAlign: "center", flex: 1 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 700, color: "#0f172a" }}>
                      {(() => {
                        const [y, m, d] = navInfo.corrente.split("-").map(Number);
                        const lun = new Date(y, m - 1, d); const dom = new Date(lun); dom.setDate(dom.getDate() + 6);
                        return `${lun.getDate()}/${lun.getMonth()+1} – ${dom.getDate()}/${dom.getMonth()+1}`;
                      })()}
                    </div>
                    <div style={{ fontSize: 11.5, color: "#94a3b8" }}>orario salvato</div>
                  </div>
                  <button onClick={() => navigaSettimana(1)} disabled={!navInfo.haSucc} style={{
                    width: 40, height: 40, borderRadius: 10, border: "1px solid #e2e8f0", cursor: navInfo.haSucc ? "pointer" : "default",
                    background: navInfo.haSucc ? "#f8fafc" : "#f1f5f9", color: navInfo.haSucc ? "#0f172a" : "#cbd5e1", fontSize: 20, lineHeight: 1,
                  }}>›</button>
                </div>
              </div>
            )}
            {orario && bozzaManuale && avvisiBozza && (
              <div style={{ padding: "12px 16px 0" }}>
                <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "12px 14px" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                    Controllo orario
                  </div>
                  <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: avvisiBozza.rossi.length || avvisiBozza.gialli.length || avvisiBozza.daCompilare ? 8 : 0 }}>
                    Tocca una cella per assegnare il turno.
                  </div>
                  {avvisiBozza.daCompilare > 0 && (
                    <div style={{ fontSize: 13, color: "#475569", marginBottom: 6 }}>
                      ✎ {avvisiBozza.daCompilare} {avvisiBozza.daCompilare === 1 ? "cella da compilare" : "celle da compilare"}
                    </div>
                  )}
                  {avvisiBozza.rossi.map((m, i) => (
                    <div key={"r" + i} style={{ fontSize: 12.5, color: "#dc2626", marginBottom: 4 }}>● {m}</div>
                  ))}
                  {avvisiBozza.gialli.map((m, i) => (
                    <div key={"g" + i} style={{ fontSize: 12.5, color: "#b45309", marginBottom: 4 }}>● {m}</div>
                  ))}
                  {avvisiBozza.rossi.length === 0 && avvisiBozza.gialli.length === 0 && avvisiBozza.daCompilare === 0 && (
                    <div style={{ fontSize: 13, color: "#16a34a", fontWeight: 600 }}>✓ Nessun problema: puoi confermare.</div>
                  )}
                </div>
              </div>
            )}
            {orario && (
              <div style={{ padding: "12px 16px 0" }}>
                <button onClick={() => setLandscape(true)} style={{
                  ...btnPrimary, background: "#1e293b", marginBottom: 0, padding: 11, fontSize: 14,
                }}>⛶ Vista a tutto schermo (orizzontale)</button>
              </div>
            )}
            <TabOrario orario={orario} employees={employees} start={start} numWeeks={numWeeks}
              onModifica={modifica} messaggi={messaggi} motore={motore} conflitti={conflitti} violazioni={violazioni}
              draft={bozzaManuale} />
          </>
        )}
        {tab === "storico" && (
          <TabStorico storico={storico} persistenza={persistenza} onApri={apriStorico} />
        )}
        {tab === "statistiche" && (
          <TabStatistiche persistenza={persistenza} />
        )}
      </main>

      {tab !== "storico" && tab !== "statistiche" && (
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, padding: 12, background: "linear-gradient(transparent, #f1f5f9 30%)" }}>
          {bozzaManuale ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={annullaManuale} style={{
                ...btnPrimary, marginBottom: 0, flex: 1, background: "#fff", color: "#0f172a",
                border: "1px solid #cbd5e1",
              }}>Annulla</button>
              <button onClick={salvaManuale}
                disabled={salvataggioBozza || !avvisiBozza || avvisiBozza.rossi.length > 0 || avvisiBozza.daCompilare > 0}
                style={{
                  ...btnPrimary, marginBottom: 0, flex: 2,
                  opacity: (salvataggioBozza || !avvisiBozza || avvisiBozza.rossi.length > 0 || avvisiBozza.daCompilare > 0) ? 0.5 : 1,
                  boxShadow: "0 4px 14px rgba(15,23,42,.25)",
                }}>
                {salvataggioBozza ? "Salvataggio…" : "Conferma orario"}
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={creaManuale} disabled={loading || employees.length === 0 || !persistenza} style={{
                ...btnPrimary, marginBottom: 0, flex: 1, background: "#fff", color: "#0f172a",
                border: "1px solid #cbd5e1",
                opacity: loading || employees.length === 0 || !persistenza ? 0.5 : 1,
              }}>Crea orario</button>
              <button onClick={genera} disabled={loading || employees.length === 0} style={{
                ...btnPrimary, marginBottom: 0, flex: 2, opacity: loading || employees.length === 0 ? 0.5 : 1,
                boxShadow: "0 4px 14px rgba(15,23,42,.25)",
              }}>
                {loading ? "Generazione… (~1 min se il server era inattivo)" : "Genera orario"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* modale di conferma (sovrascritture, uscita dalla bozza) */}
      {conferma && (
        <div onClick={() => setConferma(null)} style={modalBgCentro}>
          <div onClick={(e) => e.stopPropagation()} style={modalCentro}>
            <div style={{ fontWeight: 700, fontSize: 16, color: "#0f172a", marginBottom: 8 }}>{conferma.titolo}</div>
            <div style={{ fontSize: 13.5, color: "#475569", lineHeight: 1.5, marginBottom: 16 }}>{conferma.testo}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setConferma(null)} style={{
                flex: 1, padding: 12, borderRadius: 10, border: "1px solid #cbd5e1",
                background: "#fff", color: "#0f172a", fontSize: 14, fontWeight: 600, cursor: "pointer",
              }}>Annulla</button>
              <button onClick={() => { const f = conferma.onConferma; setConferma(null); if (f) f(); }} style={{
                flex: 1, padding: 12, borderRadius: 10, border: "none",
                background: "#0f172a", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer",
              }}>{conferma.cta || "Conferma"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ----- dati di esempio per partire subito -----
function seedEmployees() {
  // L'app parte vuota: nessun dipendente predefinito.
  return [];
}

// ----- stili condivisi -----
const lbl = { display: "block", fontSize: 12, fontWeight: 600, color: "#64748b", margin: "14px 0 6px", textTransform: "uppercase", letterSpacing: 0.4 };
const inp = { width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #cbd5e1", fontSize: 14, marginBottom: 4, boxSizing: "border-box", background: "#fff", color: "#0f172a" };
const btnPrimary = { width: "100%", padding: 14, borderRadius: 12, border: "none", background: "#0f172a", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer", marginBottom: 12 };
const empty = { textAlign: "center", color: "#94a3b8", fontSize: 14, padding: "48px 24px", lineHeight: 1.5 };
const th = { padding: "8px 4px", fontSize: 12, textAlign: "center", borderBottom: "1px solid #e2e8f0" };
const tdName = { padding: "8px 10px", fontSize: 13, fontWeight: 600, color: "#0f172a", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" };
const chip = (active) => ({ padding: "7px 12px", borderRadius: 9, border: "1px solid " + (active ? "#0f172a" : "#cbd5e1"), background: active ? "#0f172a" : "#fff", color: active ? "#fff" : "#475569", fontSize: 13, fontWeight: 500, cursor: "pointer" });
const navBtn = { width: 36, height: 36, borderRadius: "50%", border: "1px solid #cbd5e1", background: "#fff", fontSize: 18, cursor: "pointer", color: "#0f172a" };
const modalBg = { position: "fixed", inset: 0, background: "rgba(15,23,42,.4)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 100 };
const modal = { background: "#fff", borderRadius: "18px 18px 0 0", padding: 20, width: "100%", maxWidth: 480, maxHeight: "80vh", overflowY: "auto" };
// varianti per la vista a tutto schermo: menu centrato come scheda compatta
const modalBgCentro = { position: "fixed", inset: 0, background: "rgba(15,23,42,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100 };
const modalCentro = { background: "#fff", borderRadius: 18, padding: 20, width: "90%", maxWidth: 420, maxHeight: "85vh", overflowY: "auto" };
