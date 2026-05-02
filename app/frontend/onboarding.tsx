/**
 * onboarding.tsx — Telegram-style 22-question card flow ("soul" profile).
 *
 * One question per card, slide animation between cards, progress bar, draft
 * persisted to localStorage so a refresh doesn't lose progress. Final answers
 * POST to PUT /api/auth/soul; user can skip the whole flow with POST
 * /api/auth/soul/skip — both routes flip soul_complete=true so the gate in
 * index.tsx stops showing this screen.
 *
 * The question list lives in questions.ts. Adding/renaming an id there
 * requires updating soul.service.renderSoulPrompt() on the backend.
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { QUESTIONS, ACTS } from './questions';
import type { Question, ActKey } from './questions';
import { saveSoul, skipSoul } from './api';

const DRAFT_KEY = 'deeperseek_soul_draft';

type Answers = Record<string, unknown>;

interface OnboardingProps {
  /** Called after the user finishes (saved or skipped). Parent should
   *  refresh auth state so soul_complete=true and the gate releases. */
  onDone: () => void;
}

// ── Draft persistence ─────────────────────────────────────────────────────
function loadDraft(): { answers: Answers; index: number } {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return { answers: {}, index: 0 };
    const parsed = JSON.parse(raw);
    return {
      answers: (parsed && typeof parsed.answers === 'object') ? parsed.answers : {},
      index:   typeof parsed.index === 'number' ? parsed.index : 0,
    };
  } catch {
    return { answers: {}, index: 0 };
  }
}

function saveDraft(answers: Answers, index: number) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ answers, index }));
  } catch {}
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
}

// ── Main component ────────────────────────────────────────────────────────
export function Onboarding({ onDone }: OnboardingProps) {
  const [{ answers, index }, setStateRaw] = useState<{ answers: Answers; index: number }>(loadDraft);
  const [direction, setDirection] = useState<'next' | 'prev'>('next');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);

  // Persist on every change
  useEffect(() => { saveDraft(answers, index); }, [answers, index]);

  const total   = QUESTIONS.length;
  const current = QUESTIONS[Math.max(0, Math.min(index, total - 1))];
  const isLast  = index >= total - 1;
  const isFirst = index === 0;

  const setAnswer = useCallback((id: string, value: unknown) => {
    setStateRaw(s => ({ ...s, answers: { ...s.answers, [id]: value } }));
  }, []);

  const goPrev = useCallback(() => {
    if (isFirst) return;
    setDirection('prev');
    setStateRaw(s => ({ ...s, index: s.index - 1 }));
  }, [isFirst]);

  const goNext = useCallback(() => {
    setDirection('next');
    setStateRaw(s => ({ ...s, index: Math.min(s.index + 1, total - 1) }));
  }, [total]);

  // Validation: optional questions can be empty; required ones need a value.
  const currentValue = answers[current.id];
  const canAdvance = useMemo(() => {
    if (current.optional) return true;
    return hasMeaningfulValue(current, currentValue);
  }, [current, currentValue]);

  // Keyboard nav: Enter advances (not in textarea), Esc nothing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        const target = e.target as HTMLElement;
        const tag = target?.tagName?.toLowerCase();
        // Enter inside a multi-line textarea should newline, not advance
        if (tag === 'textarea') return;
        if (canAdvance) {
          e.preventDefault();
          if (isLast) submit();
          else        goNext();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line
  }, [canAdvance, isLast, current.id]);

  // ── Submit / skip ──────────────────────────────────────────────────────
  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await saveSoul(answers, true);
      clearDraft();
      onDone();
    } catch (err: any) {
      setError(err?.message || 'Failed to save. Try again?');
      setSubmitting(false);
    }
  }

  async function doSkip() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await skipSoul();
      clearDraft();
      onDone();
    } catch (err: any) {
      setError(err?.message || 'Failed to skip.');
      setSubmitting(false);
    }
  }

  // ── Per-act progress segments ──────────────────────────────────────────
  const actCounts = useMemo(() => {
    const out: Record<ActKey, { total: number; done: number }> = {
      I:     { total: 0, done: 0 },
      II:    { total: 0, done: 0 },
      III:   { total: 0, done: 0 },
      BONUS: { total: 0, done: 0 },
    };
    QUESTIONS.forEach((q, i) => {
      out[q.act].total++;
      if (i < index) out[q.act].done++;
    });
    return out;
  }, [index]);

  return (
    <div className="onboarding-screen">
      {/* ── Top bar: act badge + progress ──────────────────────────────── */}
      <header className="onb-header">
        <div className="onb-act-badge">{current.actTitle}</div>
        <div className="onb-progress">
          {(['I','II','III','BONUS'] as ActKey[]).map(k => {
            const c = actCounts[k];
            const pct = c.total === 0 ? 0 : (c.done / c.total) * 100;
            return (
              <div
                key={k}
                className={`onb-progress-seg ${current.act === k ? 'active' : ''}`}
                title={ACTS[k]}
              >
                <div className="onb-progress-bar" style={{ width: `${pct}%` }} />
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="onb-skip-all"
          onClick={() => setShowSkipConfirm(true)}
          disabled={submitting}
          title="Skip the entire questionnaire"
        >Skip all</button>
      </header>

      {/* ── Card stack ─────────────────────────────────────────────────── */}
      <div className="onb-card-wrap">
        <div
          key={current.id}
          className={`onb-card onb-slide-${direction}`}
        >
          <div className="onb-step-num">{index + 1} / {total}</div>
          <h2 className="onb-title">{current.title}</h2>
          {current.subtitle && (
            <p className="onb-subtitle">{current.subtitle}</p>
          )}

          <div className="onb-input-area">
            <QuestionInput
              question={current}
              value={currentValue}
              onChange={(v) => setAnswer(current.id, v)}
              onSubmit={() => { if (canAdvance) { isLast ? submit() : goNext(); } }}
            />
          </div>

          {error && <div className="onb-error">{error}</div>}

          <div className="onb-nav">
            <button
              type="button"
              className="onb-btn-secondary"
              onClick={goPrev}
              disabled={isFirst || submitting}
            >← Wstecz</button>

            {current.optional && !hasMeaningfulValue(current, currentValue) && (
              <button
                type="button"
                className="onb-btn-ghost"
                onClick={() => { isLast ? submit() : goNext(); }}
                disabled={submitting}
              >Pomiń</button>
            )}

            <button
              type="button"
              className="onb-btn-primary"
              onClick={() => { isLast ? submit() : goNext(); }}
              disabled={!canAdvance || submitting}
            >
              {submitting ? '…' : isLast ? 'Gotowe' : 'Dalej →'}
            </button>
          </div>
        </div>
      </div>

      {/* ── Skip-all confirm sheet ─────────────────────────────────────── */}
      {showSkipConfirm && (
        <div className="onb-modal-backdrop" onClick={() => setShowSkipConfirm(false)}>
          <div className="onb-modal" onClick={e => e.stopPropagation()}>
            <h3 className="onb-modal-title">Pominąć cały kwestionariusz?</h3>
            <p className="onb-modal-body">
              Bez tego dostajesz domyślny model — bez Twojego tonu, vibe'u, ograniczeń.
              Możesz wrócić do tego później (na razie tylko „all or nothing").
            </p>
            <div className="onb-modal-actions">
              <button
                type="button"
                className="onb-btn-secondary"
                onClick={() => setShowSkipConfirm(false)}
              >Anuluj</button>
              <button
                type="button"
                className="onb-btn-danger"
                onClick={doSkip}
                disabled={submitting}
              >Tak, pomiń</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Per-type input renderer ───────────────────────────────────────────────
interface InputProps {
  question: Question;
  value: unknown;
  onChange: (v: unknown) => void;
  /** Called when the user hits Enter inside a single-line text input. */
  onSubmit: () => void;
}

function QuestionInput({ question: q, value, onChange, onSubmit }: InputProps) {
  switch (q.type) {
    case 'text':     return <TextInput     q={q} value={value as string | undefined} onChange={onChange} onSubmit={onSubmit} />;
    case 'textarea': return <TextareaInput q={q} value={value as string | undefined} onChange={onChange} />;
    case 'slider':   return <SliderInput   q={q} value={value as number | undefined} onChange={onChange} />;
    case 'choice':   return <ChoiceInput   q={q} value={value as string | undefined} onChange={onChange} />;
    case 'multi':    return <MultiInput    q={q} value={(value as string[] | undefined) ?? []} onChange={onChange} />;
    default:         return null;
  }
}

function TextInput({ q, value, onChange, onSubmit }: {
  q: Question; value: string | undefined;
  onChange: (v: string) => void; onSubmit: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, [q.id]);
  return (
    <input
      ref={ref}
      type="text"
      className="onb-text-input"
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      placeholder={q.placeholder}
      maxLength={q.maxLength}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onSubmit(); } }}
      autoComplete="off"
      autoCapitalize="off"
      spellCheck={false}
    />
  );
}

function TextareaInput({ q, value, onChange }: {
  q: Question; value: string | undefined; onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, [q.id]);
  const len = (value || '').length;
  return (
    <div className="onb-textarea-wrap">
      <textarea
        ref={ref}
        className="onb-textarea"
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        placeholder={q.placeholder}
        maxLength={q.maxLength}
        rows={5}
      />
      {q.maxLength && (
        <div className={`onb-charcount ${len > q.maxLength * 0.9 ? 'warn' : ''}`}>
          {len}/{q.maxLength}
        </div>
      )}
    </div>
  );
}

function SliderInput({ q, value, onChange }: {
  q: Question; value: number | undefined; onChange: (v: number) => void;
}) {
  const min  = q.min ?? 0;
  const max  = q.max ?? 100;
  const step = q.step ?? 1;
  const def  = q.defaultValue ?? Math.round((min + max) / 2);
  const v    = typeof value === 'number' ? value : def;

  // Initialise default on first render so optional sliders get a value
  useEffect(() => {
    if (typeof value !== 'number') onChange(def);
    // eslint-disable-next-line
  }, [q.id]);

  const pct = ((v - min) / (max - min)) * 100;

  return (
    <div className="onb-slider-wrap">
      <div className="onb-slider-value">{v}</div>
      <div className="onb-slider-track-wrap">
        <input
          type="range"
          className="onb-slider"
          min={min}
          max={max}
          step={step}
          value={v}
          onChange={e => onChange(Number(e.target.value))}
          style={{ '--pct': `${pct}%` } as React.CSSProperties}
        />
      </div>
      {(q.minLabel || q.maxLabel) && (
        <div className="onb-slider-labels">
          <span className="onb-slider-label-min">{q.minLabel}</span>
          <span className="onb-slider-label-max">{q.maxLabel}</span>
        </div>
      )}
    </div>
  );
}

function ChoiceInput({ q, value, onChange }: {
  q: Question; value: string | undefined; onChange: (v: string) => void;
}) {
  return (
    <div className="onb-choice-list">
      {(q.options || []).map(opt => (
        <button
          key={opt.value}
          type="button"
          className={`onb-choice ${value === opt.value ? 'selected' : ''}`}
          onClick={() => onChange(opt.value)}
        >
          <span className="onb-choice-radio" />
          <span className="onb-choice-label">{opt.label}</span>
        </button>
      ))}
    </div>
  );
}

function MultiInput({ q, value, onChange }: {
  q: Question; value: string[]; onChange: (v: string[]) => void;
}) {
  const toggle = (val: string) => {
    if (value.includes(val)) onChange(value.filter(x => x !== val));
    else                     onChange([...value, val]);
  };
  return (
    <div className="onb-multi-list">
      {(q.options || []).map(opt => {
        const sel = value.includes(opt.value);
        return (
          <button
            key={opt.value}
            type="button"
            className={`onb-multi-chip ${sel ? 'selected' : ''}`}
            onClick={() => toggle(opt.value)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────
function hasMeaningfulValue(q: Question, v: unknown): boolean {
  if (v == null) return q.type === 'slider'; // sliders auto-init
  if (typeof v === 'string')  return v.trim().length > 0;
  if (typeof v === 'number')  return Number.isFinite(v);
  if (Array.isArray(v))       return v.length > 0;
  return true;
}
