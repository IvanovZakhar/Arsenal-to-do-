import React, { useEffect, useMemo, useState } from "react";
import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
} from "firebase/firestore";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "firebase/auth";

// ============================
// Cloudinary (instead of Firebase Storage)
// ============================
const CLOUDINARY_CLOUD_NAME = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME as string;
const CLOUDINARY_UPLOAD_PRESET = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET as string;
const CLOUDINARY_FOLDER = (import.meta.env.VITE_CLOUDINARY_FOLDER as string) || 'task-images';

async function uploadImage(file: File, taskId: string): Promise<string> {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_UPLOAD_PRESET) {
    throw new Error('Cloudinary env vars are missing: VITE_CLOUDINARY_CLOUD_NAME / VITE_CLOUDINARY_UPLOAD_PRESET');
  }
  if (!file.type.startsWith('image/')) throw new Error('Можно загружать только изображения');
  if (file.size > 5 * 1024 * 1024) throw new Error('Размер изображения должен быть < 5MB');
  const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/upload`;
  const form = new FormData();
  form.append('file', file);
  form.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
  form.append('folder', `${CLOUDINARY_FOLDER}/${taskId}`);
  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) throw new Error('Cloudinary upload failed');
  const data = await res.json();
  return data.secure_url as string;
}

// ============================
// Firebase init
// ============================
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// ============================
// Types & helpers
// ============================
export type Status = "none" | "red" | "yellow" | "green";
export type Task = {
  id: string;
  title: string;
  status: Status; // по умолчанию "none"
  starred: boolean; // ⭐ особая
  date: string; // YYYY-MM-DD
  createdAt: number;
  notes: string;
  imageUrl?: string; // URL из Cloudinary
  createdBy?: string | null;
};

const LIST_ID = "public"; // общий список
const pad = (n: number) => String(n).padStart(2, "0");
const toKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = toKey(new Date());
const parseKey = (key: string) => { const [y,m,d] = key.split("-").map(Number); return new Date(y, m-1, d); };
const isSameDay = (a: Date, b: Date) => a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();

function getMonthMatrix(year: number, monthIndex: number): Date[][] {
  const first = new Date(year, monthIndex, 1);
  const firstDay = (first.getDay() + 6) % 7; // Mon=0
  const start = new Date(year, monthIndex, 1 - firstDay);
  const weeks: Date[][] = [];
  for (let w=0; w<6; w++) {
    const week: Date[] = [];
    for (let d=0; d<7; d++) {
      const cur = new Date(start);
      cur.setDate(start.getDate() + w*7 + d);
      week.push(cur);
    }
    weeks.push(week);
  }
  return weeks;
}

const STATUS_META: Record<Status, { dot: string; ring: string; text: string; aria: string }> = {
  none:   { dot: "bg-slate-300",  ring: "ring-slate-300/70", text: "text-slate-400", aria: "Без статуса" },
  red:    { dot: "bg-red-500",    ring: "ring-red-400/60",   text: "text-red-500",   aria: "К выполнению" },
  yellow: { dot: "bg-yellow-400", ring: "ring-yellow-400/60", text: "text-yellow-400", aria: "В процессе" },
  green:  { dot: "bg-green-500",  ring: "ring-green-400/60",  text: "text-green-500", aria: "Готово" },
};
const STATUS_ORDER: Status[] = ["none","red","yellow","green"];
const nextStatus = (s: Status): Status => STATUS_ORDER[(STATUS_ORDER.indexOf(s)+1)%STATUS_ORDER.length];

// ============================
// Firestore helpers
// ============================
const tasksCollection = collection(db, "lists", LIST_ID, "tasks");
async function createTask(data: Omit<Task, "id" | "createdAt">) {
  await addDoc(tasksCollection, { ...data, createdAt: Date.now(), createdBy: auth.currentUser?.uid || null, ts: serverTimestamp() });
}
async function updateTaskFirebase(id: string, patch: Partial<Task>) { await updateDoc(doc(db, "lists", LIST_ID, "tasks", id), patch); }
async function deleteTaskFirebase(id: string) { await deleteDoc(doc(db, "lists", LIST_ID, "tasks", id)); }

// ============================
// Icons
// ============================
function StatusIcon({ status, className = "h-5 w-5" }: { status: Status; className?: string }) {
  if (status === "green") return <span className={`inline-block ${STATUS_META.green.text}`}>✅</span>;
  if (status === "red") return <span className={`inline-block ${STATUS_META.red.text}`}>❌</span>;
  if (status === "yellow") return <span className={`inline-block ${STATUS_META.yellow.text}`}>🟡</span>;
  return <span className={`inline-block ${STATUS_META.none.text}`}>◯</span>;
}
function StatusIconButton({ status, onClick, title }: { status: Status; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; title?: string }) {
  const s = STATUS_META[status];
  return (
    <button type="button" onClick={onClick} className={`inline-flex items-center justify-center rounded-full p-2 ring-1 ${s.ring} hover:bg-black/5`} title={title || s.aria} aria-label={s.aria}>
      <StatusIcon status={status} />
    </button>
  );
}

// ============================
// Modal with full edit & photo
// ============================
function TaskModal({ task, onClose, onSave, onUpload }: { task: Task; onClose: () => void; onSave: (patch: Partial<Task>) => void; onUpload: (file: File) => Promise<string>; }) {
  const [title, setTitle] = useState(task.title);
  const [date, setDate] = useState(task.date);
  const [status, setStatus] = useState<Status>(task.status);
  const [starred, setStarred] = useState(task.starred);
  const [imageUrl, setImageUrl] = useState<string | undefined>(task.imageUrl);
  const [busy, setBusy] = useState(false);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try { const url = await onUpload(file); setImageUrl(url); } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" role="dialog" aria-modal="true">
      <div className="w-full sm:max-w-xl sm:rounded-2xl bg-white shadow-xl ring-1 ring-black/10 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="text-lg font-semibold">Задача</h3>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100" aria-label="Закрыть">✕</button>
        </div>
        <div className="p-4 space-y-4">
          <div className="space-y-1">
            <label className="text-xs text-slate-500">Текст</label>
            <textarea value={title} onChange={(e)=>setTitle(e.target.value)} className="w-full min-h-[88px] resize-y rounded-xl border border-slate-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-300" placeholder="Текст задачи" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-slate-500">Дата</label>
              <input type="date" value={date} onChange={(e)=>setDate(e.target.value)} className="w-full rounded-xl border border-slate-200 px-3 py-2" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-slate-500">Статус</label>
              <div className="flex items-center gap-2">
                <StatusIconButton status={status} onClick={()=>setStatus(nextStatus(status))} />
                <span className="text-xs text-slate-500">Кликните по иконке</span>
              </div>
            </div>
          </div>
          <label className="inline-flex items-center gap-2 text-slate-700">
            <input type="checkbox" checked={starred} onChange={(e)=>setStarred(e.target.checked)} className="accent-amber-500 h-4 w-4" /> ⭐ особая
          </label>
          <div className="space-y-2">
            <label className="text-xs text-slate-500">Фотография</label>
            {imageUrl ? (
              <div className="space-y-2">
                <img src={imageUrl} alt="Превью" className="max-h-56 rounded-xl border w-full object-contain" />
                <div className="flex flex-wrap gap-2">
                  <label className="px-3 py-2 rounded-xl border border-slate-200 cursor-pointer hover:bg-slate-50">Заменить фото
                    <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                  </label>
                  <button onClick={()=>setImageUrl(undefined)} className="px-3 py-2 rounded-xl border border-slate-200 hover:bg-slate-50">Удалить фото</button>
                </div>
              </div>
            ) : (
              <label className="px-3 py-2 rounded-xl border border-dashed border-slate-300 text-slate-600 cursor-pointer inline-block hover:bg-slate-50">Прикрепить фото
                <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
              </label>
            )}
            {busy && <div className="text-xs text-slate-500">Загрузка…</div>}
          </div>
        </div>
        <div className="px-4 py-3 border-t flex items-center justify-end gap-2 bg-slate-50">
          <button onClick={onClose} className="px-3 py-2 rounded-xl border border-slate-200 hover:bg-white">Отмена</button>
          <button onClick={()=>onSave({ title: title.trim(), date, status, starred, imageUrl })} className="px-4 py-2 rounded-xl bg-slate-900 text-white hover:opacity-90">Сохранить</button>
        </div>
      </div>
    </div>
  );
}

// ============================
// Main App (calendar + tasks + filters)
// ============================
export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedDay, setSelectedDay] = useState<string>(todayKey);
  const [cursor, setCursor] = useState<{year:number; month:number}>(()=>{ const d=parseKey(todayKey); return {year:d.getFullYear(), month:d.getMonth()}; });
  const [modalTaskId, setModalTaskId] = useState<string | null>(null);
  const [filters, setFilters] = useState<{ q: string; status: "all"|Status; starred: boolean }>({ q:"", status:"all", starred:false });

  useEffect(()=>{ const unsub=onAuthStateChanged(auth,(u)=>{ if(!u) signInAnonymously(auth); }); return ()=>unsub(); },[]);
  useEffect(()=>{ const qy=query(tasksCollection, orderBy("createdAt","desc")); const unsub=onSnapshot(qy,(snap)=>{ const arr: Task[]=[]; snap.forEach(d=>arr.push({ id:d.id, ...(d.data() as any)})); setTasks(arr); }); return ()=>unsub(); },[]);

  const tasksByDay = useMemo(()=>{
    const map = new Map<string, Task[]>();
    for (const t of tasks) { if (!map.has(t.date)) map.set(t.date, []); map.get(t.date)!.push(t); }
    for (const arr of map.values()) {
      arr.sort((a,b)=>{ if (a.starred!==b.starred) return a.starred?-1:1; const si=STATUS_ORDER.indexOf(a.status)-STATUS_ORDER.indexOf(b.status); if (si!==0) return si; return a.createdAt-b.createdAt; });
    }
    return map;
  },[tasks]);

  const matrix = useMemo(()=>getMonthMatrix(cursor.year, cursor.month),[cursor]);
  const monthLabel = useMemo(()=>new Date(cursor.year, cursor.month, 1).toLocaleString("ru-RU",{month:"long", year:"numeric"}),[cursor]);

  const [draft, setDraft] = useState<{ title:string; status:Status; starred:boolean }>({ title:"", status:"none", starred:false });
  async function submitDraft(e?: React.FormEvent) { e?.preventDefault(); if (!draft.title.trim()) return; await createTask({ title:draft.title.trim(), status:draft.status, starred:draft.starred, date:selectedDay, notes:"" }); setDraft({ title:"", status:"none", starred:false }); }

  const selectedTasksRaw = tasksByDay.get(selectedDay) || [];
  const selectedTasks = selectedTasksRaw.filter((t)=>{
    if (filters.status!=='all' && t.status!==filters.status) return false;
    if (filters.starred && !t.starred) return false;
    if (filters.q && !t.title.toLowerCase().includes(filters.q.toLowerCase())) return false;
    return true;
  });

  const modalTask = modalTaskId ? tasks.find(t=>t.id===modalTaskId) || null : null;

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white text-slate-900 p-4 sm:p-6">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold">Задачник АрсеналЪ</h1>
            <p className="text-sm text-slate-600">Задачи по дням, статусы и фото. Публичный список.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={()=>{ const d=new Date(); setCursor({year:d.getFullYear(), month:d.getMonth()}); setSelectedDay(todayKey); }} className="px-3 py-2 rounded-xl bg-slate-900 text-white text-sm">Сегодня</button>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Calendar */}
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <button onClick={()=>{ const m=cursor.month-1; const d=new Date(cursor.year, m, 1); setCursor({year:d.getFullYear(), month:d.getMonth()}); }} className="p-2 rounded-xl hover:bg-slate-100">◀</button>
                <button onClick={()=>{ const m=cursor.month+1; const d=new Date(cursor.year, m, 1); setCursor({year:d.getFullYear(), month:d.getMonth()}); }} className="p-2 rounded-xl hover:bg-slate-100">▶</button>
                <h2 className="text-lg font-semibold capitalize">{monthLabel}</h2>
              </div>
              <div className="flex items-center gap-3">
                <StatusIcon status="none" />
                <StatusIcon status="red" />
                <StatusIcon status="yellow" />
                <StatusIcon status="green" />
              </div>
            </div>
            <div className="grid grid-cols-7 text-xs font-medium text-slate-500 mb-1">
              {["Пн","Вт","Ср","Чт","Пт","Сб","Вс"].map((d)=>(<div key={d} className="py-1 text-center">{d}</div>))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {matrix.flat().map((date, idx)=>{
                const inMonth = date.getMonth()===cursor.month;
                const key = toKey(date);
                const count = tasksByDay.get(key)?.length || 0;
                const starredAny = tasksByDay.get(key)?.some(t=>t.starred);
                const isSelected = key===selectedDay;
                const isToday = isSameDay(date, new Date());
                return (
                  <button key={idx} onClick={()=>setSelectedDay(key)} className={`group aspect-square rounded-xl border text-sm flex flex-col items-center justify-center transition ${isSelected?"border-slate-900 ring-2 ring-slate-900/10":"border-slate-200 hover:border-slate-300"} ${inMonth?"bg-white":"bg-slate-50 text-slate-400"}`} title={`Задач: ${count}`}>
                    <div className="flex items-center gap-1">
                      <span className={`font-medium ${isToday?"inline-flex items-center justify-center h-6 w-6 rounded-full bg-slate-900 text-white":""}`}>{date.getDate()}</span>
                      {starredAny && <span className="text-amber-500">⭐</span>}
                    </div>
                    <div className="mt-1 flex gap-0.5">
                      {count>0 ? (["none","red","yellow","green"] as Status[]).map((s)=>{ const n=tasksByDay.get(key)?.filter(t=>t.status===s).length||0; return n>0 ? <span key={s} className={`h-1.5 w-3 rounded ${STATUS_META[s].dot}`} /> : null; }) : (<span className="h-1.5 w-3 rounded bg-slate-200" />)}
                    </div>
                    {count>0 && <div className="mt-1 text-[10px] text-slate-500">{count}</div>}
                  </button>
                );
              })}
            </div>
          </section>

          {/* Tasks */}
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between mb-3 gap-2">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">Задачи на день</h2>
                <span className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-700">{new Date(selectedDay).toLocaleDateString("ru-RU",{day:"2-digit",month:"short"})}</span>
              </div>
              <div className="flex items-center gap-2 text-sm w-full sm:w-auto">
                <input type="search" value={filters.q} onChange={(e)=>setFilters(f=>({...f,q:e.target.value}))} placeholder="Поиск…" className="px-3 py-2 rounded-xl border border-slate-200 flex-1" />
                <select value={filters.status} onChange={(e)=>setFilters(f=>({...f, status: e.target.value as any }))} className="px-3 py-2 rounded-xl border border-slate-200 bg-white" title="Фильтр по статусу">
                  <option value="all">Все</option>
                  <option value="none">◯</option>
                  <option value="red">❌</option>
                  <option value="yellow">🟡</option>
                  <option value="green">✅</option>
                </select>
                <label className="inline-flex items-center gap-2 text-slate-600 cursor-pointer select-none">
                  <input type="checkbox" className="accent-amber-500 h-4 w-4" checked={filters.starred} onChange={(e)=>setFilters(f=>({...f, starred:e.target.checked}))} /> Только ⭐
                </label>
              </div>
            </div>

            {/* New task */}
            <form onSubmit={submitDraft} className="mb-4 grid grid-cols-1 sm:grid-cols-[auto_1fr_auto_auto] gap-2 items-center">
              <StatusIconButton status={draft.status} onClick={(e)=>{ e.preventDefault(); setDraft(d=>({...d,status:nextStatus(d.status)})); }} title="Сменить статус новой задачи" />
              <input value={draft.title} onChange={(e)=>setDraft(d=>({...d,title:e.target.value}))} placeholder="Новая задача…" className="px-3 py-2 rounded-xl border border-slate-200" />
              <label className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-slate-200 text-slate-700">
                <input type="checkbox" checked={draft.starred} onChange={(e)=>setDraft(d=>({...d,starred:e.target.checked}))} className="accent-amber-500 h-4 w-4" /> ⭐ особая
              </label>
              <button type="submit" className="px-4 py-2 rounded-xl bg-slate-900 text-white">Добавить</button>
            </form>

            {/* Task list */}
            <div className="space-y-2">
              {selectedTasks.length===0 && (<div className="text-sm text-slate-500 border rounded-xl border-dashed p-6 text-center">Нет задач. Добавьте первую выше 👆</div>)}
              {selectedTasks.map((t)=>(
                <article key={t.id} className="group rounded-xl border border-slate-200 bg-white p-3 flex items-center gap-3 shadow-sm">
                  <div className={`h-8 w-1.5 rounded-full ${STATUS_META[t.status].dot}`} />
                  <button type="button" onClick={()=>updateTaskFirebase(t.id,{ starred:!t.starred })} className="p-2 rounded-full hover:bg-black/5" aria-pressed={t.starred} title={t.starred?"Убрать звёздочку":"Отметить звёздочкой"}><span className={`text-lg ${t.starred?"text-amber-500":"text-gray-300"}`}>⭐</span></button>
                  <StatusIconButton status={t.status} onClick={()=>updateTaskFirebase(t.id,{ status: nextStatus(t.status) })} />
                  <button onClick={()=>setModalTaskId(t.id)} className="flex-1 text-left px-2 py-1 rounded-lg hover:bg-slate-50 overflow-hidden"><div className="truncate whitespace-nowrap overflow-hidden text-ellipsis">{t.title || <span className="text-slate-400">(без текста)</span>}</div></button>
                  <input type="date" value={t.date} onChange={(e)=>updateTaskFirebase(t.id,{ date:e.target.value })} className="hidden sm:block px-3 py-2 rounded-xl border border-slate-200 text-sm" />
                  <button type="button" onClick={()=>deleteTaskFirebase(t.id)} className="p-2 rounded-full hover:bg-black/5 text-gray-500" title="Удалить">🗑️</button>
                </article>
              ))}
            </div>

            {/* Counters */}
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
              {(["none","red","yellow","green"] as Status[]).map((s)=>(
                <div key={s} className="rounded-xl border border-slate-200 p-3 flex items-center justify-between">
                  <div className="flex items-center gap-2"><StatusIcon status={s} /></div>
                  <span className="font-semibold">{selectedTasksRaw.filter(t=>t.status===s).length}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Overview */}
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="text-base font-semibold mb-3">Быстрый обзор по дням</h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {[...tasksByDay.keys()].sort().map((key)=>(
              <button key={key} onClick={()=>{ setSelectedDay(key); const d=parseKey(key); setCursor({year:d.getFullYear(), month:d.getMonth()}); }} className={`flex items-center justify-between rounded-xl border p-3 text-left ${key===selectedDay?"border-slate-900":"border-slate-200 hover:border-slate-300"}`}>
                <div className="flex items-center gap-2">
                  <span className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-700">{parseKey(key).toLocaleDateString("ru-RU",{day:"2-digit",month:"short"})}</span>
                  {tasksByDay.get(key)?.some(t=>t.starred) && <span className="text-amber-500">⭐</span>}
                </div>
                <div className="flex items-center gap-1 text-xs">
                  {(["none","red","yellow","green"] as Status[]).map((s)=>(<span key={s} className={`px-1.5 py-0.5 rounded-full ${STATUS_META[s].dot} text-white`}>{tasksByDay.get(key)?.filter(t=>t.status===s).length || 0}</span>))}
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="mt-6 text-xs text-slate-500">
          <ul className="list-disc pl-4 space-y-1">
            <li>Новая задача создаётся <em>без статуса</em> (◯). Цикл: ◯ → ❌ → 🟡 → ✅ → ◯.</li>
            <li>Клик по тексту открывает карточку с редактированием и фото (Cloudinary).</li>
            <li>Все изменения в реальном времени через Firestore.</li>
          </ul>
        </section>
      </div>

      {modalTask && (
        <TaskModal task={modalTask} onClose={()=>setModalTaskId(null)} onSave={(patch)=>{ updateTaskFirebase(modalTask.id, patch); setModalTaskId(null); }} onUpload={async(file)=>{ const url=await uploadImage(file, modalTask.id); await updateTaskFirebase(modalTask.id,{ imageUrl:url }); return url; }} />
      )}
    </div>
  );
}
