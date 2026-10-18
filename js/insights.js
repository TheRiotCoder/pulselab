// Plain-language insights computed from the user's own data. Every insight states its sample size (n)
// and is withheld when there is not enough data. These are statistical associations, not medical advice.
import { S } from './state.js';
import { inRange, sleepDebt, sdMinutes, bandOf, ACWR_HIGH, ACWR_LOW } from './analysis.js';
import { correlate, mean, median, quantile, valid, sd, fmtDur, fmtNum, fmtDay, fmtClock, trend, clamp } from './util.js';

const MIN_N = 14;
// Deviation from the trailing 60-day baseline. HRV uses ln scale (geometric mean), so the % is a ratio.
const devPct = (d, k) => {
  if (!valid(d[k]) || !d['b_' + k]) return null;
  if (k === 'hrv') return d.hrv > 0 && !d.hrvCoarse ? (Math.exp(Math.log(d.hrv) - d.b_hrv.mean) - 1) * 100 : null;
  return (d[k] - d['b_' + k].mean) / d['b_' + k].mean * 100;
};
const devAbs = (d, k) => (valid(d[k]) && d['b_' + k]) ? d[k] - d['b_' + k].mean : null;
const sgn = (v, dp = 1) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(dp);

function strengthWord(r) { const a = Math.abs(r); return a < 0.2 ? 'no meaningful' : a < 0.35 ? 'a weak' : a < 0.55 ? 'a moderate' : 'a strong'; }
function confOf(c) {
  if (c.r == null) return null;
  if (c.p < 0.01 && c.n >= 30 && Math.abs(c.r) >= 0.45) return 'higher';
  if (c.p < 0.05 && Math.abs(c.r) >= 0.3) return 'moderate';
  return 'low';
}
function groupSplit(rows, threshold) { // rows [{x,y}]
  const hi = rows.filter(r => r.x >= threshold).map(r => r.y), lo = rows.filter(r => r.x < threshold).map(r => r.y);
  return { hi, lo };
}

function corrInsight({ id, title, pairs, xl, yl, unitX, describe, groups, need }) {
  const c = correlate(pairs);
  if (c.n < MIN_N) return { id, title, insufficient: true, n: c.n, need: MIN_N, hint: need || 'Needs at least ' + MIN_N + ' days with both measurements in the selected range.' };
  const conf = confOf(c);
  const dir = c.r > 0 ? 'higher' : 'lower';
  let text;
  if (conf === 'low') text = c.p < 0.05 && Math.abs(c.r) >= 0.1
    ? `Only a weak link (r = ${c.r.toFixed(2)}, p = ${c.p.toFixed(3)}), too small to act on and easily explained by other factors. Treat it as no clear relationship.`
    : `No reliable link found (r = ${c.r.toFixed(2)}, p = ${c.p < 0.001 ? '<0.001' : c.p.toFixed(2)}). With this much data, ${describe.none}`;
  else text = `${describe.link(dir, strengthWord(c.r))} (r = ${c.r.toFixed(2)}).`;
  if (groups) text += ' ' + groups;
  return { id, title, n: c.n, conf, text, r: c.r, p: c.p, scatter: { pts: pairs.filter(q => valid(q[0]) && valid(q[1])), xl, yl, fit: c }, how: `Pearson correlation across ${c.n} paired days; p-value ${c.p < 0.001 ? '<0.001' : c.p.toFixed(3)}. “Higher” confidence needs p<0.01, n≥30 and |r|≥0.45; “moderate” needs p<0.05 and |r|≥0.3; anything weaker is reported as no reliable link. Association does not prove cause.` };
}

export function computeInsights(m, range = S.range) {
  const out = { cards: [], insufficient: [], anomalies: [], trends: [], suggestions: [], weekly: null, range };
  if (m.empty) return out;
  const days = inRange(m, range);
  const need = S.settings.sleepNeedH * 60;
  const push = c => (c.insufficient ? out.insufficient : out.cards).push(c);

  // 1. sleep -> HRV (same morning: Garmin's HRV is measured during that night's sleep)
  {
    const rows = days.filter(d => valid(d.sleepMin) && devPct(d, 'hrv') != null).map(d => ({ x: d.sleepMin / 60, y: devPct(d, 'hrv') }));
    let grp = '';
    const th = need / 60, g = groupSplit(rows, th);
    if (g.hi.length >= 5 && g.lo.length >= 5) grp = `On nights of ${fmtDur(need)}+, HRV averaged ${sgn(mean(g.hi))}% vs your baseline (n=${g.hi.length}); on shorter nights ${sgn(mean(g.lo))}% (n=${g.lo.length}).`;
    push(corrInsight({ id: 'sleep-hrv', title: 'Sleep length and HRV', pairs: rows.map(r => [r.x, r.y]), xl: 'Sleep (h)', yl: 'HRV vs baseline (%)', groups: grp,
      describe: { link: (dir, w) => `Longer sleep goes with ${dir === 'higher' ? 'higher' : 'lower'} overnight HRV for you — ${w} association`, none: 'sleep duration does not predict your overnight HRV beyond random day-to-day noise.' } }));
  }
  // 2. sleep -> resting HR
  {
    const rows = days.filter(d => valid(d.sleepMin) && devAbs(d, 'rhr') != null).map(d => ({ x: d.sleepMin / 60, y: devAbs(d, 'rhr') }));
    const th = need / 60, g = groupSplit(rows, th); let grp = '';
    if (g.hi.length >= 5 && g.lo.length >= 5) grp = `After nights of ${fmtDur(need)}+, resting HR averaged ${sgn(mean(g.hi))} bpm vs baseline (n=${g.hi.length}); after shorter nights ${sgn(mean(g.lo))} bpm (n=${g.lo.length}).`;
    push(corrInsight({ id: 'sleep-rhr', title: 'Sleep length and resting HR', pairs: rows.map(r => [r.x, r.y]), xl: 'Sleep (h)', yl: 'Resting HR vs baseline (bpm)', groups: grp,
      describe: { link: (dir, w) => `More sleep goes with ${dir === 'higher' ? 'a higher' : 'a lower'} resting HR the same day — ${w} association`, none: 'sleep length does not noticeably move your resting HR.' } }));
  }
  // 3. sleep -> workout efficiency
  {
    const byType = {};
    const eff = a => (a.durationSec >= 900 && a.avgHr) ? (a.type === 'cycling' && a.avgPower ? a.avgPower / a.avgHr : a.speed ? a.speed * 60 / a.avgHr : null) : null;
    const hist = {};
    for (const a of m.acts) {
      const e = eff(a); if (e == null || !['running', 'cycling', 'walking', 'hiking'].includes(a.type)) continue;
      const h = hist[a.type] = hist[a.type] || [];
      if (h.length >= 3) {
        const base = median(h.slice(-10)); const day = m.byDate.get(a.day);
        if (day && valid(day.sleepMin) && (!range || a.day >= days[0].date)) (byType[a.type] = byType[a.type] || []).push([day.sleepMin / 60, (e / base - 1) * 100]);
      }
      h.push(e);
    }
    const best = Object.entries(byType).sort((a, b) => b[1].length - a[1].length)[0];
    if (!best || best[1].length < 10) push({ id: 'sleep-perf', title: 'Sleep and workout efficiency', insufficient: true, n: best ? best[1].length : 0, need: 10, hint: 'Needs at least 10 runs or rides (15+ min, with heart rate and distance/power) that also have sleep data.' });
    else {
      const unit = best[0] === 'cycling' ? 'watts per beat' : 'metres per heartbeat';
      push(corrInsight({ id: 'sleep-perf', title: 'Sleep and ' + best[0] + ' efficiency', pairs: best[1], xl: 'Sleep (h)', yl: 'Efficiency vs recent (%)',
        describe: { link: (dir, w) => `${dir === 'higher' ? 'Better' : 'Worse'} efficiency (${unit}) tends to follow longer sleep — ${w} association`, none: `your ${best[0]} efficiency (${unit}) is not clearly related to the previous night’s sleep. Fitness, heat and pacing also move this number.` } }));
    }
  }
  // 4. stress -> next sleep
  {
    const rows = [];
    for (const d of days) { const p = m.days[d.i - 1]; if (p && valid(p.stress) && valid(d.sleepMin)) rows.push([p.stress, d.sleepMin / 60]); }
    push(corrInsight({ id: 'stress-sleep', title: 'Daytime stress and that night’s sleep', pairs: rows, xl: 'Avg stress (previous day)', yl: 'Sleep (h)',
      describe: { link: (dir, w) => `Higher-stress days are followed by ${dir === 'higher' ? 'longer' : 'shorter'} sleep — ${w} association`, none: 'your daytime stress level does not clearly predict how long you sleep.' } }));
  }
  // 5. bedtime regularity -> HRV
  {
    const rows = [];
    for (const d of days) {
      if (!valid(d.bedMin) || devPct(d, 'hrv') == null) continue;
      const prior = m.days.slice(Math.max(0, d.i - 14), d.i).map(x => x.bedMin).filter(valid);
      if (prior.length < 7) continue;
      rows.push({ reg: Math.abs(d.bedMin - median(prior)) <= 30, y: devPct(d, 'hrv') });
    }
    const a = rows.filter(r => r.reg).map(r => r.y), b = rows.filter(r => !r.reg).map(r => r.y);
    if (a.length >= 5 && b.length >= 5) {
      const diff = mean(a) - mean(b);
      // Welch t as a rough guard so small differences are not oversold
      const se = Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length); const t = se ? diff / se : 0;
      const conf = Math.abs(t) > 2.6 && Math.min(a.length, b.length) >= 15 ? 'higher' : Math.abs(t) > 2 ? 'moderate' : 'low';
      out.cards.push({ id: 'bedtime-hrv', title: 'Regular bedtime and HRV', n: a.length + b.length, conf,
        text: conf === 'low' ? `No reliable difference: HRV was ${sgn(mean(a))}% vs baseline after on-schedule nights (within 30 min of your usual bedtime, n=${a.length}) and ${sgn(mean(b))}% after off-schedule nights (n=${b.length}).`
          : `HRV averaged ${sgn(mean(a))}% vs baseline after on-schedule nights (within 30 min of your usual bedtime, n=${a.length}) compared with ${sgn(mean(b))}% after off-schedule nights (n=${b.length}).`,
        how: `Group comparison; “usual bedtime” is the median of the previous 14 nights. Rough Welch t = ${t.toFixed(1)}.` });
    } else out.insufficient.push({ id: 'bedtime-hrv', title: 'Regular bedtime and HRV', insufficient: true, n: a.length + b.length, need: 10, hint: 'Needs bedtimes (from sleep data) and at least 5 on- and 5 off-schedule nights.' });
  }
  // 6. hard-day recovery
  {
    const loads = m.days.filter(d => d.trimp > 0).map(d => d.trimp);
    const th = loads.length >= 12 ? Math.max(quantile(loads, 0.75), 1) : null;
    const hard = th ? days.filter(d => d.trimp >= th) : [];
    if (hard.length < 6) out.insufficient.push({ id: 'recovery', title: 'Recovery after hard days', insufficient: true, n: hard.length, need: 6, hint: 'Needs at least 6 “hard” days (top quarter of your training load) with HRV or resting HR data in the selected range.' });
    else {
      // Garmin dates sleep/HRV by WAKE date: HRV on date D is the night BEFORE D's workout. So lag 0 is a pre-session
      // baseline check; the first night that can reflect the session is +1 day.
      const lags = [0, 1, 2, 3, 4].map(L => {
        const hv = hard.map(h => m.days[h.i + L]).filter(Boolean).map(d => devPct(d, 'hrv')).filter(valid);
        const rh = hard.map(h => m.days[h.i + L]).filter(Boolean).map(d => devAbs(d, 'rhr')).filter(valid);
        return { L, hrv: hv.length >= 4 ? median(hv) : null, rhr: rh.length >= 4 ? median(rh) : null, n: Math.max(hv.length, rh.length) };
      });
      const pre = lags[0], l1 = lags[1];
      const eff = lags.slice(1).filter(l => l.hrv != null);
      const worst = eff.slice().sort((a, b) => a.hrv - b.hrv)[0];
      const back = lags.slice(2).find(l => l.hrv != null && l.hrv >= -2 && (!worst || l.L > worst.L));
      const whenTxt = L => L === 1 ? 'the first morning after the session' : `${L} mornings after the session`;
      let text = `After your hardest days (top quarter of training load, n=${hard.length}), `;
      if (worst && worst.hrv < -3) text += `HRV was typically ${sgn(worst.hrv)}% vs baseline ${whenTxt(worst.L)}` + (back ? ` and was back near baseline by +${back.L} days.` : '.');
      else text += 'your HRV did not drop noticeably below baseline on the following mornings, suggesting you recover well from these sessions (or the data is too noisy to tell).';
      if (l1.rhr != null) text += ` Resting HR the next day: ${sgn(l1.rhr)} bpm vs baseline.`;
      if (pre.hrv != null && pre.hrv < -3) text += ` Note: you tended to start these sessions already ${Math.abs(pre.hrv).toFixed(0)}% below baseline, so part of any later dip may predate the session.`;
      const bars = [];
      if (pre.hrv != null) bars.push({ label: 'Morning of (before the session)', v: pre.hrv });
      for (const l of lags.slice(1)) if (l.hrv != null) bars.push({ label: '+' + l.L + ' day' + (l.L > 1 ? 's' : ''), v: l.hrv });
      out.cards.push({ id: 'recovery', title: 'Recovery after hard days', n: hard.length, conf: worst && worst.hrv < -3 && hard.length >= 12 ? 'moderate' : 'low', text, bars, barsLabel: 'Median HRV vs baseline (%). “Before” is the night before the session (Garmin dates HRV by wake date), shown only as a baseline check; the effect starts at +1 day.',
        how: `Hard day = training load ≥ the 75th percentile of your training days (${fmtNum(th, 0)} approx. TRIMP). HRV is dated by wake date, so the HRV on a session’s date is from the night before the session; +1 day is the first night after it. HRV deviations are on the ln scale (shown as %). Medians; lags with fewer than 4 readings are omitted. Hard days that cluster together blur this effect.` });
      out.recovery = lags;
    }
  }

  // Weekly summary: last 7 days vs previous 7 days
  {
    const last = m.days.slice(-7), prev = m.days.slice(-14, -7);
    const mk = (label, f, fmt, goodUp, unit = '') => {
      const a = last.map(f).filter(valid), b = prev.map(f).filter(valid);
      if (a.length < 3) return { label, v: null };
      const va = mean(a), vb = b.length >= 3 ? mean(b) : null;
      return { label, v: va, vtxt: fmt(va) + unit, prev: vb, ptxt: vb != null ? fmt(vb) + unit : null, delta: vb != null ? va - vb : null, goodUp, n: a.length };
    };
    const sumLoad = (arr) => arr.reduce((s, d) => s + d.trimp, 0);
    out.weekly = {
      from: last[0].date, to: last[last.length - 1].date,
      rows: [
        mk('Sleep', d => d.sleepMin, v => fmtDur(v), true), mk('HRV', d => d.hrv, v => fmtNum(v), true, ' ms'), mk('Resting HR', d => d.rhr, v => fmtNum(v, 1), false, ' bpm'),
        mk('Stress', d => d.stress, v => fmtNum(v), false), mk('Steps / day', d => d.steps, v => fmtNum(v), true), mk('Readiness', d => d.readiness ? d.readiness.score : null, v => fmtNum(v), true),
        { label: 'Training load', v: sumLoad(last), vtxt: fmtNum(sumLoad(last)) + ' TRIMP', prev: sumLoad(prev), ptxt: fmtNum(sumLoad(prev)) + ' TRIMP', delta: sumLoad(last) - sumLoad(prev), goodUp: null, n: 7 },
        { label: 'Workouts', v: last.reduce((s, d) => s + d.acts.length, 0), vtxt: String(last.reduce((s, d) => s + d.acts.length, 0)), prev: prev.reduce((s, d) => s + d.acts.length, 0), ptxt: String(prev.reduce((s, d) => s + d.acts.length, 0)), delta: last.reduce((s, d) => s + d.acts.length, 0) - prev.reduce((s, d) => s + d.acts.length, 0), goodUp: null, n: 7 }
      ]
    };
  }

  // Anomalies in the last 14 days (z-score vs 60-day trailing baseline; HRV on the ln scale)
  {
    const recent = m.days.slice(-14);
    const specs = [['hrv', 'HRV', v => fmtNum(v) + ' ms'], ['rhr', 'Resting HR', v => fmtNum(v) + ' bpm'], ['sleepMin', 'Sleep', v => fmtDur(v)], ['stress', 'Stress', v => fmtNum(v)], ['steps', 'Steps', v => fmtNum(v)]];
    for (const d of recent) for (const [k, label, f] of specs) {
      const z = d['z_' + k]; if (z == null || Math.abs(z) < 2) continue;
      const b = d['b_' + k]; const baseVal = k === 'hrv' ? Math.exp(b.mean) : b.mean;
      out.anomalies.push({ date: d.date, metric: label, value: f(d[k]), base: f(baseVal), z, n: b.n, dir: z > 0 ? 'high' : 'low' });
    }
    out.anomalies.sort((a, b) => b.date.localeCompare(a.date) || Math.abs(b.z) - Math.abs(a.z));
    // "Strain pattern": HRV well below AND resting HR well above baseline on the same day (single-night z-scores).
    // One day is only "worth watching"; the stronger warning needs 2+ consecutive days.
    const hit = recent.map(d => d.z_hrv != null && d.z_rhr != null && d.z_hrv <= -1.5 && d.z_rhr >= 1.5);
    out.strain = []; out.watch = []; out.strainRuns = [];
    for (let i = 0; i < recent.length;) {
      if (!hit[i]) { i++; continue; }
      let j = i; while (j + 1 < recent.length && hit[j + 1]) j++;
      const run = recent.slice(i, j + 1).map(d => d.date);
      if (run.length >= 2) { out.strain.push(...run); out.strainRuns.push(run); } else out.watch.push(run[0]);
      i = j + 1;
    }
  }

  // Trends
  {
    const specs = [['rhr', 'Resting HR', 'bpm', false, 1], ['hrv', 'HRV', 'ms', true, 1], ['sleepMin', 'Sleep duration', 'min', true, 0], ['stress', 'Stress', '', false, 1], ['steps', 'Steps', '', true, 0], ['vo2max', 'VO₂ max', '', true, 1], ['ready', 'Readiness (own score)', '', true, 1]];
    const w = days.length >= 21 ? days : [];
    for (const [k, label, unit, goodUp, dp] of specs) {
      const pts = w.map(d => [d.i, k === 'ready' ? (d.readiness ? d.readiness.score : null) : d[k]]).filter(p => valid(p[1]));
      if (pts.length < 21) { out.trends.push({ label, insufficient: true, n: pts.length }); continue; }
      const t = trend(pts); const perWeek = t.slope * 7; const avg = mean(pts.map(p => p[1]));
      const sig = t.p < 0.05 && Math.abs(t.r) >= 0.2;
      out.trends.push({ label, n: pts.length, slopeWeek: perWeek, pctWeek: avg ? perWeek / avg * 100 : null, sig, up: perWeek > 0, good: sig ? (perWeek > 0) === goodUp : null, unit, dp, r: t.r, p: t.p });
    }
  }

  // Suggestions (rule based, hedged, each cites its basis)
  {
    const sg = out.suggestions; const last = m.days[m.days.length - 1];
    const sd7 = sleepDebt(m.days, need);
    if (sd7.nights >= 4 && sd7.debt >= 180) sg.push({ text: `You are about ${fmtDur(sd7.debt)} under your ${fmtDur(need)} target over the last ${sd7.nights} recorded nights. If you can, bank an earlier night or two before hard sessions.`, basis: `Sleep debt, n=${sd7.nights} nights` });
    const bt = m.days.slice(-14).map(d => d.bedMin).filter(valid);
    if (bt.length >= 7 && sdMinutes(bt) > 60) sg.push({ text: `Your bedtime has varied by about ±${Math.round(sdMinutes(bt))} minutes over the last two weeks. A steadier schedule is a common, low-effort way to improve sleep quality.`, basis: `Bedtime SD, n=${bt.length} nights` });
    const sh = out.cards.find(c => c.id === 'sleep-hrv');
    if (sh && sh.conf !== 'low' && sh.r > 0) sg.push({ text: 'In your data, longer sleep goes with higher HRV. Protecting sleep the night before an important session may pay off for you.', basis: `Sleep→HRV, n=${sh.n}, ${sh.conf} confidence` });
    if (last && valid(last.acwr)) {
      if (last.acwr > ACWR_HIGH) sg.push({ text: `Your recent training load is ${last.acwr.toFixed(2)}× your 4-week average. Load that jumped quickly is associated with more fatigue, so consider an easier day or two if you feel flat. (Load is an approximate, heart-rate-based estimate.)`, basis: 'Acute:chronic load ratio' });
      else if (last.acwr < ACWR_LOW) sg.push({ text: `Your recent training load (${last.acwr.toFixed(2)}× your 4-week average) is below your usual. That is fine for a recovery week; if it was unplanned, ease back in gradually.`, basis: 'Acute:chronic load ratio' });
    }
    const care = 'This is not a diagnosis. Seek care for fever, chest pain, shortness of breath or fainting.';
    if (out.strainRuns && out.strainRuns.length) {
      const r = out.strainRuns[out.strainRuns.length - 1];
      sg.push({ text: `Your HRV was well below and resting HR well above your norm together on ${r.length} consecutive days (${r.map(d => fmtDay(d)).join(', ')}). That pattern can accompany illness, poor sleep, alcohol, stress or heavy training. Consider easing off while it lasts. ${care}`, basis: 'z-scores vs 60-day baseline, 2+ consecutive days' });
    } else if (out.watch && out.watch.length) {
      sg.push({ text: `On ${out.watch.map(d => fmtDay(d)).join(', ')} your HRV was well below and resting HR well above your norm on a single night. That is worth watching, but one night is not a signal on its own (poor sleep, alcohol, a hard session or stress are common causes). ${care}`, basis: 'z-scores vs 60-day baseline, single night' });
    }
    const rc = out.recovery && out.recovery[1];
    if (rc && rc.hrv != null && rc.hrv < -5) sg.push({ text: `Your HRV usually dips about ${Math.abs(rc.hrv).toFixed(0)}% the morning after your hardest days. Spacing hard sessions at least 48 h apart may suit your pattern.`, basis: `Hard-day recovery, n=${rc.n}` });
    const st = out.trends.find(t => t.label === 'Steps');
    if (st && st.sig && !st.good) sg.push({ text: 'Your daily steps are trending down. Short walks are an easy way to reverse that.', basis: `Steps trend, n=${st.n}` });
    if (!sg.length) sg.push({ text: 'Nothing stands out right now. Keep logging; insights sharpen as more weeks of data accumulate.', basis: 'No rule triggered' });
  }
  return out;
}
