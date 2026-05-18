import { getLocalISODateString } from '../utils/date';
import React, { useState, useEffect } from 'react';
import axios from 'axios';
import {
    CheckCircle2,
    Circle,
    XCircle,
    Calendar as CalendarIcon,
    Activity,
    Layers,
    Tag,
    ChevronLeft,
    ChevronRight,
    RefreshCw,
    Search,
    Settings2,
    X,
    Clock,
    AlertTriangle,
    Trash2,
    Plus,
    Lock,
    Unlock
} from 'lucide-react';

const ExecutionManager = ({ token, apiKey }) => {
    const [selectedDate, setSelectedDate] = useState(getLocalISODateString());
    const [dayData, setDayData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');

    // Exception modal state
    const [isExceptionModalOpen, setIsExceptionModalOpen] = useState(false);
    const [selectedTask, setSelectedTask] = useState(null);
    const [taskExceptions, setTaskExceptions] = useState([]);
    const [exceptionForm, setExceptionForm] = useState({
        exception_type: 'SKIP',
        override_load_value: '',
        start_time: '',
        end_time: '',
        notes: '',
        is_locked: false
    });
    const [editingExceptionId, setEditingExceptionId] = useState(null);

    const api = axios.create({
        baseURL: import.meta.env.VITE_API_BASE_URL || '/api/lbs',
        headers: {
            'Authorization': token ? `Bearer ${token}` : undefined,
            'X-API-Key': !token ? apiKey : undefined
        }
    });

    const fetchDayData = async (dateStr) => {
        setLoading(true);
        try {
            const statusParams = "status=todo&status=done&status=skipped";
            const resp = await api.get(`/calculate/${dateStr}?${statusParams}`);
            setDayData(resp.data);
        } catch (err) {
            console.error("Error fetching execution data:", err);
            alert("Error fetching data: " + (err.response?.data?.detail || err.message));
        } finally {
            setLoading(false);
        }
    };

    const fetchTaskExceptions = async (taskId) => {
        try {
            const resp = await api.get('/exceptions', { params: { task_id: taskId } });
            setTaskExceptions(resp.data);
        } catch (err) {
            console.error("Error fetching exceptions:", err);
            setTaskExceptions([]);
        }
    };

    useEffect(() => {
        if (token || apiKey) fetchDayData(selectedDate);
    }, [selectedDate, token, apiKey]);

    const handleToggleStatus = async (taskId, newStatus) => {
        setLoading(true);
        try {
            await api.post(`/tasks/${taskId}/complete`, {
                target_date: selectedDate,
                status: newStatus
            });
            await fetchDayData(selectedDate);
        } catch (err) {
            alert("Error updating status: " + (err.response?.data?.detail || err.message));
        } finally {
            setLoading(false);
        }
    };

    const openExceptionModal = async (task) => {
        setSelectedTask(task);
        setEditingExceptionId(null);
        setExceptionForm({
            exception_type: 'SKIP',
            override_load_value: '',
            start_time: '',
            end_time: '',
            notes: '',
            is_locked: false
        });
        await fetchTaskExceptions(task.task_id);
        setIsExceptionModalOpen(true);
    };

    const closeExceptionModal = () => {
        setIsExceptionModalOpen(false);
        setSelectedTask(null);
        setTaskExceptions([]);
        setEditingExceptionId(null);
    };

    const handleCreateException = async () => {
        if (!selectedTask) return;
        try {
            const payload = {
                task_id: selectedTask.task_id,
                target_date: selectedDate,
                exception_type: exceptionForm.exception_type,
                override_load_value: exceptionForm.override_load_value ? parseFloat(exceptionForm.override_load_value) : null,
                start_time: exceptionForm.start_time || null,
                end_time: exceptionForm.end_time || null,
                notes: exceptionForm.notes || null,
                is_locked: exceptionForm.is_locked
            };
            await api.post('/exceptions?force_override=true', payload);
            await fetchTaskExceptions(selectedTask.task_id);
            await fetchDayData(selectedDate);
            setExceptionForm({ exception_type: 'SKIP', override_load_value: '', start_time: '', end_time: '', notes: '', is_locked: false });
        } catch (err) {
            alert("Error creating exception: " + (err.response?.data?.detail || err.message));
        }
    };

    const handleUpdateException = async () => {
        if (!editingExceptionId) return;
        try {
            const payload = {
                exception_type: exceptionForm.exception_type,
                override_load_value: exceptionForm.override_load_value ? parseFloat(exceptionForm.override_load_value) : null,
                start_time: exceptionForm.start_time || null,
                end_time: exceptionForm.end_time || null,
                notes: exceptionForm.notes || null,
                is_locked: exceptionForm.is_locked
            };
            await api.put(`/exceptions/${editingExceptionId}?force_override=true`, payload);
            await fetchTaskExceptions(selectedTask.task_id);
            await fetchDayData(selectedDate);
            setEditingExceptionId(null);
            setExceptionForm({ exception_type: 'SKIP', override_load_value: '', start_time: '', end_time: '', notes: '', is_locked: false });
        } catch (err) {
            alert("Error updating exception: " + (err.response?.data?.detail || err.message));
        }
    };

    const handleDeleteException = async (exceptionId) => {
        if (!confirm("Delete this exception?")) return;
        try {
            await api.delete(`/exceptions/${exceptionId}?force_override=true`);
            await fetchTaskExceptions(selectedTask.task_id);
            await fetchDayData(selectedDate);
        } catch (err) {
            alert("Error deleting exception: " + (err.response?.data?.detail || err.message));
        }
    };

    const startEditException = (exc) => {
        setEditingExceptionId(exc.id);
        setExceptionForm({
            exception_type: exc.exception_type,
            override_load_value: exc.override_load_value || '',
            start_time: exc.start_time || '',
            end_time: exc.end_time || '',
            notes: exc.notes || '',
            is_locked: exc.is_locked || false
        });
    };

    const changeDate = (offset) => {
        const d = new Date(selectedDate);
        d.setDate(d.getDate() + offset);
        setSelectedDate(getLocalISODateString(d));
    };

    const getLevelColor = (level) => {
        switch (level) {
            case 'SAFE': return '#10b981';
            case 'WARNING': return '#f59e0b';
            case 'DANGER': return '#ef4444';
            case 'CRITICAL': return '#8b5cf6';
            default: return '#3b82f6';
        }
    };

    const filteredTasks = dayData?.tasks.filter(t =>
        t.task_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.context.toLowerCase().includes(searchQuery.toLowerCase())
    ) || [];

    const stats = dayData ? [
        { label: 'Total Load', value: dayData.adjusted_load.toFixed(2), icon: Activity, color: getLevelColor(dayData.level) },
        { label: 'Task Count', value: dayData.task_count, icon: Layers, color: '#a855f7' },
        { label: 'Contexts', value: dayData.unique_contexts, icon: Tag, color: '#10b981' },
    ] : [];

    return (
        <div className="flex flex-col gap-10">
            {/* Header & Date Selector */}
            <header className="flex justify-between items-end">
                <div>
                    <h2 className="text-3xl font-bold mb-1">Execution Log</h2>
                    <p className="text-slate-400">Manage daily task completion and execution status.</p>
                </div>

                <div className="flex items-center gap-4 bg-white/5 p-2 rounded-2xl border border-white/5 shadow-xl">
                    <button onClick={() => changeDate(-1)} className="p-3 hover:bg-white/5 rounded-xl text-slate-400 hover:text-white transition-all"><ChevronLeft size={20} /></button>
                    <div className="flex items-center gap-3 px-4 min-w-[200px] justify-center">
                        <CalendarIcon size={18} className="text-blue-400" />
                        <span className="font-bold text-lg">
                            {new Date(selectedDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                        </span>
                    </div>
                    <button onClick={() => changeDate(1)} className="p-3 hover:bg-white/5 rounded-xl text-slate-400 hover:text-white transition-all"><ChevronRight size={20} /></button>
                </div>
            </header>

            {/* Daily Stats KPI */}
            <div className="grid grid-cols-3 gap-6">
                {stats.map((s, i) => (
                    <div key={i} className="glass-card p-6 flex flex-col gap-2 relative overflow-hidden group">
                        <div className="flex items-center gap-3 text-slate-500 text-[10px] uppercase font-bold tracking-widest">
                            <s.icon size={14} style={{ color: s.color }} /> {s.label}
                        </div>
                        <div className="text-3xl font-bold" style={{ color: i === 0 ? s.color : 'white' }}>{s.value}</div>
                        <div className="absolute top-0 right-0 p-8 opacity-[0.03] group-hover:opacity-[0.07] transition-all">
                            <s.icon size={80} />
                        </div>
                    </div>
                ))}
            </div>

            {/* Task List Section */}
            <div className="flex flex-col gap-6">
                <div className="flex justify-between items-center">
                    <div className="flex items-center gap-4 flex-grow max-w-md">
                        <div className="relative w-full">
                            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
                            <input
                                className="w-full bg-white/5 border-white/5 hover:border-white/10 transition-all pl-12 h-12 rounded-2xl text-sm"
                                placeholder="Search today's tasks..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                            />
                        </div>
                        <button
                            onClick={() => fetchDayData(selectedDate)}
                            className={`p-3 glass-card text-slate-400 hover:text-white transition-all ${loading ? 'animate-spin' : ''}`}
                        >
                            <RefreshCw size={20} />
                        </button>
                    </div>
                </div>

                <div className="grid grid-cols-1 gap-3">
                    {loading && !dayData ? (
                        <div className="py-20 text-center text-slate-500 animate-pulse uppercase tracking-widest text-xs font-bold">Loading schedule...</div>
                    ) : filteredTasks.length === 0 ? (
                        <div className="py-20 text-center glass-card border-dashed border-white/5 text-slate-500">
                            {searchQuery ? "No matching tasks found." : "No tasks scheduled for this date."}
                        </div>
                    ) : (
                        filteredTasks.map((task, idx) => {
                            const isDone = task.status === 'done';
                            const isSkipped = task.status === 'skipped';
                            return (
                                <div key={idx} className={`glass-card p-5 flex justify-between items-center bg-white/5 transition-all border ${isDone ? 'border-emerald-500/20 bg-emerald-500/5' : isSkipped ? 'border-amber-500/20 bg-amber-500/5' : 'border-transparent hover:bg-white/10'}`}>
                                    <div className="flex items-center gap-6">
                                        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-bold font-mono text-sm ${isDone ? 'bg-emerald-500/10 text-emerald-400' : isSkipped ? 'bg-amber-500/10 text-amber-400' : 'bg-blue-500/10 text-blue-400'}`}>
                                            {task.load.toFixed(1)}
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <span className={`text-lg font-bold flex items-center gap-2 ${isDone ? 'text-emerald-400/80 line-through' : 'text-slate-200'}`}>
                                                {task.task_name}
                                                {task.is_locked && <Lock size={14} className="text-amber-500" />}
                                            </span>
                                            <div className="flex items-center gap-3">
                                                <span className="text-[10px] text-slate-500 uppercase font-bold tracking-widest px-2 py-0.5 rounded bg-white/5 border border-white/5">
                                                    {task.context}
                                                </span>
                                                {task.status !== 'todo' && (
                                                    <span className={`text-[8px] px-2 py-0.5 rounded-full font-bold uppercase ${isDone ? 'bg-emerald-500/20 text-emerald-400' : isSkipped ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400'}`}>
                                                        {task.status}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-3">
                                        <button
                                            onClick={() => openExceptionModal(task)}
                                            className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all ${task.is_locked ? 'bg-amber-500/10 text-amber-500 hover:bg-amber-500/20' : 'bg-white/5 text-slate-500 hover:text-purple-400 hover:bg-purple-500/10'}`}
                                            title={task.is_locked ? "Manage Locked Configuration" : "Manage Exceptions"}
                                        >
                                            <Settings2 size={20} />
                                        </button>
                                        <button
                                            onClick={() => handleToggleStatus(task.task_id, isDone ? 'todo' : 'done')}
                                            disabled={loading}
                                            className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all ${isDone ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20' : 'bg-white/5 text-slate-500 hover:text-emerald-400 hover:bg-emerald-500/10'}`}
                                            title={isDone ? "Mark as Todo" : "Mark as Done"}
                                        >
                                            <CheckCircle2 size={22} />
                                        </button>
                                        <button
                                            onClick={() => handleToggleStatus(task.task_id, isSkipped ? 'todo' : 'skipped')}
                                            disabled={loading}
                                            className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all ${isSkipped ? 'bg-amber-500 text-white shadow-lg shadow-amber-500/20' : 'bg-white/5 text-slate-500 hover:text-amber-400 hover:bg-amber-500/10'}`}
                                            title={isSkipped ? "Restore" : "Skip Task"}
                                        >
                                            <XCircle size={22} />
                                        </button>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>

            {/* Exception Modal */}
            {isExceptionModalOpen && selectedTask && (
                <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-slate-900 border border-white/10 rounded-3xl w-full max-w-xl max-h-[90vh] overflow-y-auto shadow-2xl">
                        <div className="p-6 border-b border-white/10 flex justify-between items-center">
                            <div>
                                <h3 className="text-xl font-bold">Exception Manager</h3>
                                <p className="text-slate-400 text-sm">{selectedTask.task_name} • {selectedDate}</p>
                            </div>
                            <button onClick={closeExceptionModal} className="p-2 hover:bg-white/10 rounded-xl transition-all">
                                <X size={20} />
                            </button>
                        </div>

                        <div className="p-6 flex flex-col gap-6">
                            {/* Exception Form */}
                            <div className="flex flex-col gap-4">
                                <h4 className="text-sm font-bold uppercase tracking-widest text-slate-500">
                                    {editingExceptionId ? 'Edit Exception' : 'Create New Exception'}
                                </h4>

                                <div className="grid grid-cols-2 gap-4">
                                    <div className="col-span-2">
                                        <label className="text-xs text-slate-500 uppercase font-bold mb-1 block">Exception Type</label>
                                        <select
                                            className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm"
                                            value={exceptionForm.exception_type}
                                            onChange={(e) => {
                                                const newType = e.target.value;
                                                setExceptionForm({
                                                    ...exceptionForm,
                                                    exception_type: newType,
                                                    is_locked: newType === 'MANUAL_LOCK' ? true : exceptionForm.is_locked
                                                });
                                            }}
                                        >
                                            <option value="SKIP">SKIP - Skip this occurrence</option>
                                            <option value="OVERRIDE_LOAD">OVERRIDE_LOAD - Change load value</option>
                                            <option value="FORCE_DO">FORCE_DO - Force task on this date</option>
                                            <option value="RESCHEDULE">RESCHEDULE - Change time only</option>
                                            <option value="MANUAL_LOCK">MANUAL_LOCK - Set values and lock</option>
                                        </select>
                                    </div>

                                    {(exceptionForm.exception_type === 'OVERRIDE_LOAD' || exceptionForm.exception_type === 'FORCE_DO' || exceptionForm.exception_type === 'MANUAL_LOCK') && (
                                        <div>
                                            <label className="text-xs text-slate-500 uppercase font-bold mb-1 block">Override Load</label>
                                            <input
                                                type="number"
                                                step="0.1"
                                                className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm"
                                                placeholder="e.g. 3.5"
                                                value={exceptionForm.override_load_value}
                                                onChange={(e) => setExceptionForm({ ...exceptionForm, override_load_value: e.target.value })}
                                            />
                                        </div>
                                    )}

                                    {exceptionForm.exception_type !== 'SKIP' && (
                                        <>
                                            <div>
                                                <label className="text-xs text-slate-500 uppercase font-bold mb-1 block">Start Time</label>
                                                <input
                                                    type="time"
                                                    className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm"
                                                    value={exceptionForm.start_time}
                                                    onChange={(e) => setExceptionForm({ ...exceptionForm, start_time: e.target.value })}
                                                />
                                            </div>

                                            <div>
                                                <label className="text-xs text-slate-500 uppercase font-bold mb-1 block">End Time</label>
                                                <input
                                                    type="time"
                                                    className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm"
                                                    value={exceptionForm.end_time}
                                                    onChange={(e) => setExceptionForm({ ...exceptionForm, end_time: e.target.value })}
                                                />
                                            </div>
                                        </>
                                    )}

                                    <div className="col-span-2">
                                        <label className="text-xs text-slate-500 uppercase font-bold mb-1 block">Notes</label>
                                        <textarea
                                            className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm resize-none"
                                            rows={2}
                                            placeholder="Optional notes..."
                                            value={exceptionForm.notes}
                                            onChange={(e) => setExceptionForm({ ...exceptionForm, notes: e.target.value })}
                                        />
                                    </div>

                                    <div className="col-span-2 flex items-center gap-3">
                                        <button
                                            type="button"
                                            onClick={() => setExceptionForm({ ...exceptionForm, is_locked: !exceptionForm.is_locked })}
                                            className={`w-12 h-6 rounded-full transition-all relative ${exceptionForm.is_locked ? 'bg-purple-500' : 'bg-white/10'}`}
                                        >
                                            <div className={`w-5 h-5 rounded-full bg-white absolute top-0.5 transition-all ${exceptionForm.is_locked ? 'left-6' : 'left-0.5'}`} />
                                        </button>
                                        <label className="text-sm text-slate-300">Lock Exception</label>
                                        <span className="text-xs text-slate-500">(Prevent external modifications)</span>
                                    </div>
                                </div>

                                <div className="flex gap-3">
                                    {editingExceptionId ? (
                                        <>
                                            <button
                                                onClick={handleUpdateException}
                                                className="flex-1 bg-purple-500 hover:bg-purple-600 text-white py-3 rounded-xl font-bold transition-all flex items-center justify-center gap-2"
                                            >
                                                Update Exception
                                            </button>
                                            <button
                                                onClick={() => {
                                                    setEditingExceptionId(null);
                                                    setExceptionForm({ exception_type: 'SKIP', override_load_value: '', start_time: '', end_time: '', notes: '', is_locked: false });
                                                }}
                                                className="px-6 bg-white/5 hover:bg-white/10 py-3 rounded-xl font-bold transition-all"
                                            >
                                                Cancel
                                            </button>
                                        </>
                                    ) : (
                                        <button
                                            onClick={handleCreateException}
                                            className="flex-1 bg-purple-500 hover:bg-purple-600 text-white py-3 rounded-xl font-bold transition-all flex items-center justify-center gap-2"
                                        >
                                            <Plus size={18} /> Create Exception
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Existing Exceptions */}
                            <div className="flex flex-col gap-3">
                                <h4 className="text-sm font-bold uppercase tracking-widest text-slate-500">
                                    Existing Exceptions ({taskExceptions.length})
                                </h4>

                                {taskExceptions.length === 0 ? (
                                    <div className="text-center py-8 text-slate-500 text-sm">No exceptions for this task.</div>
                                ) : (
                                    taskExceptions.map((exc) => (
                                        <div key={exc.id} className="bg-white/5 border border-white/10 rounded-xl p-4 flex justify-between items-start">
                                            <div className="flex flex-col gap-1">
                                                <div className="flex items-center gap-2">
                                                    <span className={`text-xs px-2 py-0.5 rounded font-bold uppercase ${exc.exception_type === 'SKIP' ? 'bg-amber-500/20 text-amber-400' :
                                                        exc.exception_type === 'FORCE_DO' ? 'bg-emerald-500/20 text-emerald-400' :
                                                            'bg-blue-500/20 text-blue-400'
                                                        }`}>
                                                        {exc.exception_type}
                                                    </span>
                                                    <span className="text-sm text-slate-400">{exc.target_date}</span>
                                                </div>
                                                {exc.override_load_value && (
                                                    <span className="text-xs text-slate-500">Load: {exc.override_load_value}</span>
                                                )}
                                                {(exc.start_time || exc.end_time) && (
                                                    <span className="text-xs text-slate-500 flex items-center gap-1">
                                                        <Clock size={10} /> {exc.start_time || '--:--'} - {exc.end_time || '--:--'}
                                                    </span>
                                                )}
                                                {exc.notes && <span className="text-xs text-slate-400 italic">{exc.notes}</span>}
                                            </div>
                                            <div className="flex gap-2">
                                                <button
                                                    onClick={() => startEditException(exc)}
                                                    className="p-2 hover:bg-white/10 rounded-lg transition-all text-slate-400 hover:text-white"
                                                >
                                                    <Settings2 size={16} />
                                                </button>
                                                <button
                                                    onClick={() => handleDeleteException(exc.id)}
                                                    className="p-2 hover:bg-red-500/20 rounded-lg transition-all text-slate-400 hover:text-red-400"
                                                >
                                                    <Trash2 size={16} />
                                                </button>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ExecutionManager;
