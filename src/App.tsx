import React, { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

type EventBlock = {
  start: number; // inclusive slot index
  end: number;   // inclusive slot index
  title: string;
};

type DragMode = 'none' | 'create' | 'move' | 'resize-left' | 'resize-right';

type DragState = {
  mode: DragMode;
  row: number | null;
  eventIndex: number | null; // for move/resize
  anchorSlot: number | null; // slot where mouse down happened
  initialStart: number | null; // original event start for move/resize
  initialEnd: number | null;   // original event end for move/resize
};

// Persistence schema
type ScheduleV1 = {
  version: 1;
  savedAt: string; // ISO string
  rows: EventBlock[][];
};

const STORAGE_KEY = 'scheduler_v1';

const ROWS = 3;
const START_HOUR = 9;   // 9 AM
const END_HOUR = 20;    // 8 PM (20:00)
const SLOTS_PER_HOUR = 4; // 15 min intervals
const TOTAL_SLOTS = (END_HOUR - START_HOUR) * SLOTS_PER_HOUR; // 44 slots

// ---- Validation helpers for persistence ----
function isValidEventBlock(ev: EventBlock): boolean {
  if (typeof ev.start !== 'number' || typeof ev.end !== 'number' || typeof ev.title !== 'string') return false;
  if (!Number.isInteger(ev.start) || !Number.isInteger(ev.end)) return false;
  if (ev.start < 0 || ev.end < 0 || ev.start > ev.end) return false;
  if (ev.end > TOTAL_SLOTS - 1) return false;
  return true;
}

function rowsHaveNoOverlap(rows: EventBlock[][]): boolean {
  for (const row of rows) {
    const sorted = [...row].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev.end >= cur.start) return false; // overlaps or touches? Existing UI allows back-to-back, so equality means touching which is allowed, but we used ">=". Change to strictly >.
    }
  }
  return true;
}

function rowsHaveNoStrictOverlap(rows: EventBlock[][]): boolean {
  for (const row of rows) {
    const sorted = [...row].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev.end >= cur.start) {
        // Allow back-to-back: prev.end === cur.start - 1
        if (prev.end >= cur.start) {
          if (prev.end >= cur.start) {
            if (prev.end >= cur.start) {
              if (prev.end >= cur.start && !(prev.end === cur.start - 1)) return false;
            }
          }
        }
      }
    }
  }
  return true;
}

function validateRows(rows: EventBlock[][]): boolean {
  if (!Array.isArray(rows) || rows.length !== ROWS) return false;
  for (const row of rows) {
    if (!Array.isArray(row)) return false;
    for (const ev of row) {
      if (!isValidEventBlock(ev)) return false;
    }
  }
  // Ensure no overlap (strict)
  const copy = rows.map(r => [...r].sort((a, b) => a.start - b.start));
  for (const r of copy) {
    for (let i = 1; i < r.length; i++) {
      const prev = r[i - 1];
      const cur = r[i];
      if (prev.end >= cur.start) {
        if (prev.end !== cur.start - 1) return false;
      }
    }
  }
  return true;
}

function makeSchedule(rows: EventBlock[][]): ScheduleV1 {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    rows,
  };
}

function saveToStorage(rows: EventBlock[][]) {
  try {
    const sched = makeSchedule(rows);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sched));
  } catch (e) {
    // ignore
  }
}

function loadFromStorage(): ScheduleV1 | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1) return null;
    if (!validateRows(parsed.rows)) return null;
    return parsed as ScheduleV1;
  } catch (e) {
    return null;
  }
}

function formatTimeLabel(hour: number) {
  const h12 = ((hour + 11) % 12) + 1;
  const suffix = hour < 12 ? 'AM' : 'PM';
  return `${h12} ${suffix}`;
}

function shortTimeLabel(slotIdx: number) {
  // e.g., 9:00 AM, 9:15, 9:30, 9:45, 10:00 AM, ...
  const minutesPerSlot = 60 / SLOTS_PER_HOUR;
  const totalMinutes = START_HOUR * 60 + slotIdx * minutesPerSlot;
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  const h12 = ((hour + 11) % 12) + 1;
  const mm = minute.toString().padStart(2, '0');
  const isHourStart = slotIdx % SLOTS_PER_HOUR === 0;
  const suffix = hour < 12 ? 'AM' : 'PM';
  return isHourStart ? `${h12}:00 ${suffix}` : `${h12}:${mm}`;
}

function App() {
  const [events, setEvents] = useState<EventBlock[][]>(Array.from({ length: ROWS }, () => []));
  const [status, setStatus] = useState<string>('');
  const saveTimer = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // selection state (for creating a new event)
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectRow, setSelectRow] = useState<number | null>(null);
  const [selectStart, setSelectStart] = useState<number | null>(null);
  const [selectCurrent, setSelectCurrent] = useState<number | null>(null);

  // drag state (for moving/resizing existing events)
  const [drag, setDrag] = useState<DragState>({
    mode: 'none',
    row: null,
    eventIndex: null,
    anchorSlot: null,
    initialStart: null,
    initialEnd: null,
  });

  useEffect(() => {
    function handleMouseUp() {
      // Commit create flow
      if (isSelecting && selectRow !== null && selectStart !== null && selectCurrent !== null) {
        const start = Math.min(selectStart, selectCurrent);
        const end = Math.max(selectStart, selectCurrent);
        const title = window.prompt('Event title?', 'New Event');
        if (title && title.trim()) {
          setEvents(prev => {
            const copy = prev.map(row => row.slice());
            copy[selectRow!].push({ start, end, title: title.trim() });
            return copy;
          });
        }
      }
      // Clear both select & drag states
      setIsSelecting(false);
      setSelectRow(null);
      setSelectStart(null);
      setSelectCurrent(null);
      setDrag({ mode: 'none', row: null, eventIndex: null, anchorSlot: null, initialStart: null, initialEnd: null });
    }
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, [isSelecting, selectRow, selectStart, selectCurrent]);

  // Load from localStorage once on mount
  useEffect(() => {
    const stored = loadFromStorage();
    if (stored && validateRows(stored.rows)) {
      setEvents(stored.rows);
      setStatus('Loaded saved schedule');
      window.setTimeout(() => setStatus(''), 1500);
    }
  }, []);

  // Auto-save with debounce when events change
  useEffect(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      try {
        saveToStorage(events);
        setStatus('Saved');
        window.setTimeout(() => setStatus(''), 1200);
      } catch (e) {
        setStatus('Save failed');
      }
    }, 500);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [events]);

  const slotIndices = useMemo(() => Array.from({ length: TOTAL_SLOTS }, (_, i) => i), []);

  function findEventAt(rowIdx: number, slotIdx: number) {
    const idx = events[rowIdx].findIndex(ev => slotIdx >= ev.start && slotIdx <= ev.end);
    return idx >= 0 ? idx : null;
  }

  function clamp(val: number, min: number, max: number) {
    return Math.max(min, Math.min(max, val));
  }

  function rangeOverlaps(aStart: number, aEnd: number, bStart: number, bEnd: number) {
    return aStart <= bEnd && bStart <= aEnd;
  }

  function allowedRangeFor(rowIdx: number, excludeIndex: number | null, start: number, end: number): { start: number; end: number } {
    let s = clamp(start, 0, TOTAL_SLOTS - 1);
    let e = clamp(end, 0, TOTAL_SLOTS - 1);
    if (s > e) [s, e] = [e, s];
    const others = events[rowIdx].filter((_, i) => i !== excludeIndex);
    for (const o of others) {
      if (rangeOverlaps(s, e, o.start, o.end)) {
        // If overlaps, snap to edge depending on direction
        if (e >= o.start && s <= o.start) {
          e = o.start - 1;
        } else if (s <= o.end && e >= o.end) {
          s = o.end + 1;
        }
      }
    }
    s = clamp(s, 0, TOTAL_SLOTS - 1);
    e = clamp(e, 0, TOTAL_SLOTS - 1);
    if (s > e) s = e; // collapse if necessary
    return { start: s, end: e };
  }

  function onMouseDownCell(rowIdx: number, slotIdx: number) {
    // If clicking on an existing event, decide drag mode
    const evtIndex = findEventAt(rowIdx, slotIdx);
    if (evtIndex !== null) {
      const evt = events[rowIdx][evtIndex];
      let mode: DragMode = 'move';
      if (evt.start === evt.end) {
        mode = 'move';
      } else if (slotIdx === evt.start) {
        mode = 'resize-left';
      } else if (slotIdx === evt.end) {
        mode = 'resize-right';
      } else {
        mode = 'move';
      }
      setDrag({
        mode,
        row: rowIdx,
        eventIndex: evtIndex,
        anchorSlot: slotIdx,
        initialStart: evt.start,
        initialEnd: evt.end,
      });
      return; // don't start create selection
    }

    // Otherwise, start create selection
    setIsSelecting(true);
    setSelectRow(rowIdx);
    setSelectStart(slotIdx);
    setSelectCurrent(slotIdx);
  }

  function onMouseEnterCell(rowIdx: number, slotIdx: number) {
    // Create selection mode
    if (isSelecting && rowIdx === selectRow) {
      setSelectCurrent(slotIdx);
      return;
    }

    // Dragging existing event
    if (drag.mode !== 'none' && drag.row === rowIdx && drag.eventIndex !== null && drag.initialStart !== null && drag.initialEnd !== null && drag.anchorSlot !== null) {
      if (drag.mode === 'move') {
        const len = drag.initialEnd - drag.initialStart;
        let newStart = drag.initialStart + (slotIdx - drag.anchorSlot);
        let newEnd = newStart + len;
        // clamp to bounds first
        if (newStart < 0) {
          newEnd -= newStart; // shift right by deficit
          newStart = 0;
        }
        if (newEnd > TOTAL_SLOTS - 1) {
          const over = newEnd - (TOTAL_SLOTS - 1);
          newStart -= over;
          newEnd = TOTAL_SLOTS - 1;
        }
        // prevent overlaps
        const allowed = allowedRangeFor(rowIdx, drag.eventIndex, newStart, newEnd);
        applyTempUpdate(rowIdx, drag.eventIndex, allowed.start, allowed.end);
      } else if (drag.mode === 'resize-left') {
        let newStart = Math.min(slotIdx, drag.initialEnd);
        const allowed = allowedRangeFor(rowIdx, drag.eventIndex, newStart, drag.initialEnd);
        applyTempUpdate(rowIdx, drag.eventIndex, allowed.start, allowed.end);
      } else if (drag.mode === 'resize-right') {
        let newEnd = Math.max(slotIdx, drag.initialStart);
        const allowed = allowedRangeFor(rowIdx, drag.eventIndex, drag.initialStart, newEnd);
        applyTempUpdate(rowIdx, drag.eventIndex, allowed.start, allowed.end);
      }
    }
  }

  function applyTempUpdate(rowIdx: number, eventIdx: number, start: number, end: number) {
    setEvents(prev => {
      const copy = prev.map(row => row.slice());
      const evts = copy[rowIdx].slice();
      const original = evts[eventIdx];
      evts[eventIdx] = { ...original, start, end };
      copy[rowIdx] = evts;
      return copy;
    });
  }

  function getCellClass(rowIdx: number, slotIdx: number) {
    let cls = 'slot';

    // hour boundary marker class for stronger grid line
    if (slotIdx % SLOTS_PER_HOUR === 0) {
      cls += ' hour-boundary';
    }

    // selection highlight for create
    if (isSelecting && selectRow === rowIdx && selectStart !== null && selectCurrent !== null) {
      const s = Math.min(selectStart, selectCurrent);
      const e = Math.max(selectStart, selectCurrent);
      if (slotIdx >= s && slotIdx <= e) {
        cls += ' selecting';
      }
    }

    // event occupancy
    const evt = events[rowIdx].find(ev => slotIdx >= ev.start && slotIdx <= ev.end);
    if (evt) {
      if (slotIdx === evt.start && slotIdx === evt.end) {
        cls += ' event single';
      } else if (slotIdx === evt.start) {
        cls += ' event start';
      } else if (slotIdx === evt.end) {
        cls += ' event end';
      } else {
        cls += ' event middle';
      }
      // Add title to the start cell
      if (slotIdx === evt.start) {
        cls += ' has-title';
      }
      // Cursor hints
      if (slotIdx === evt.start && evt.start !== evt.end) {
        cls += ' handle-left';
      } else if (slotIdx === evt.end && evt.start !== evt.end) {
        cls += ' handle-right';
      } else if (slotIdx > evt.start && slotIdx < evt.end) {
        cls += ' draggable';
      }
    }

    return cls;
  }

  function cellTitle(rowIdx: number, slotIdx: number): string | undefined {
    const evt = events[rowIdx].find(ev => slotIdx >= ev.start && slotIdx <= ev.end);
    if (evt && slotIdx === evt.start) return evt.title;
    return undefined;
  }

  function clearRow(rowIdx: number) {
    if (window.confirm('Clear all events in this row?')) {
      setEvents(prev => prev.map((row, i) => (i === rowIdx ? [] : row)));
    }
  }

  function removeEvent(rowIdx: number, eventIdx: number) {
    setEvents(prev => prev.map((row, i) => {
      if (i !== rowIdx) return row;
      const copy = row.slice();
      copy.splice(eventIdx, 1);
      return copy;
    }));
  }

  function timeForSlot(slotIdx: number) {
    const minutesPerSlot = 60 / SLOTS_PER_HOUR; // 15 minutes when SLOTS_PER_HOUR=4
    const totalMinutes = START_HOUR * 60 + slotIdx * minutesPerSlot;
    const hour = Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;
    const h12 = ((hour + 11) % 12) + 1;
    const suffix = hour < 12 ? 'AM' : 'PM';
    const mm = minute.toString().padStart(2, '0');
    return `${h12}:${mm} ${suffix}`;
  }

  function handleManualSave() {
    try {
      saveToStorage(events);
      setStatus('Saved');
      window.setTimeout(() => setStatus(''), 1200);
    } catch (e) {
      setStatus('Save failed');
    }
  }

  function handleManualLoad() {
    const stored = loadFromStorage();
    if (stored && validateRows(stored.rows)) {
      setEvents(stored.rows);
      setStatus('Loaded saved schedule');
      window.setTimeout(() => setStatus(''), 1500);
    } else {
      setStatus('No saved schedule found');
      window.setTimeout(() => setStatus(''), 1500);
    }
  }

  function handleExport() {
    try {
      const sched = makeSchedule(events);
      const blob = new Blob([JSON.stringify(sched, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      a.href = url;
      a.download = `schedule-${ts}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setStatus('Export failed');
      window.setTimeout(() => setStatus(''), 1500);
    }
  }

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result);
        const parsed = JSON.parse(text);
        if (!parsed || parsed.version !== 1 || !validateRows(parsed.rows)) {
          alert('Invalid schedule file.');
          return;
        }
        if (window.confirm('Importing will replace current schedule. Continue?')) {
          setEvents(parsed.rows);
          setStatus('Imported');
          window.setTimeout(() => setStatus(''), 1500);
        }
      } catch (err) {
        alert('Failed to read schedule file.');
      }
    };
    reader.onerror = () => alert('Failed to read file.');
    reader.readAsText(file);
  }

  function handleClearAll() {
    if (window.confirm('Clear all rows and events?')) {
      setEvents(Array.from({ length: ROWS }, () => []));
    }
  }

  return (
    <div className="App">
      <h1>Schedule</h1>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <button onClick={handleManualSave} aria-label="Save schedule">Save</button>
        <button onClick={handleManualLoad} aria-label="Load schedule">Load</button>
        <button onClick={handleExport} aria-label="Export schedule as JSON">Export</button>
        <button onClick={handleImportClick} aria-label="Import schedule from JSON">Import</button>
        <button onClick={handleClearAll} aria-label="Clear all">Clear All</button>
        <input ref={fileInputRef} type="file" accept="application/json" onChange={handleImportFile} style={{ display: 'none' }} />
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#667085' }}>{status}</span>
      </div>

      <div className="timeline">
        <div className="time-header " style={{ gridTemplateColumns: `repeat(${TOTAL_SLOTS}, 1fr)` }}>
          {slotIndices.map((idx) => {
            const isHourStart = idx % SLOTS_PER_HOUR === 0;
            return (
              <div key={idx} className={`time-cell ${isHourStart ? 'hour-start' : ''}`}>
                {shortTimeLabel(idx)}
              </div>
            );
          })}
        </div>

        {Array.from({ length: ROWS }, (_, r) => (
          <div key={r} className="row">
            <div className="row-label">
              DAY {r + 1}
              <button className="clear-btn" onClick={() => clearRow(r)}>Clear</button>
            </div>
            <div className="row-grid" style={{ gridTemplateColumns: `repeat(${TOTAL_SLOTS}, 1fr)` }}>
              {slotIndices.map((idx) => {
                const eventIdx = findEventAt(r, idx);
                const evt = eventIdx !== null ? events[r][eventIdx] : null;
                const isEventStart = !!evt && idx === evt.start;
                return (
                  <div
                    key={idx}
                    className={getCellClass(r, idx)}
                    onMouseDown={() => onMouseDownCell(r, idx)}
                    onMouseEnter={() => onMouseEnterCell(r, idx)}
                    title={timeForSlot(idx)}
                  >
                    {isEventStart && (
                      <>
                        <span className="event-title">{evt!.title}</span>
                        <button
                          className="event-delete"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); removeEvent(r, eventIdx!); }}
                          aria-label="Delete event"
                          title="Delete event"
                        >
                          ×
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="help">
        - 15-minute intervals. Drag across cells to create. Drag from the start/end edge to resize. Drag from the middle to move within the row. Click × on the start cell to delete an event. Use Save/Load for local persistence, or Export/Import JSON to move schedules between browsers.
      </div>
    </div>
  );
}

export default App;
