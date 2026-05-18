import { getLocalISODateString, getTimezoneName } from '../utils/date';
import React, { useState, useEffect } from 'react';
import axios from 'axios';
import {
    Plus, Edit2, Trash2, Calendar, CheckCircle2, XCircle,
    Menu, Filter, Search, Tag, Clock, ChevronDown, Upload, Download,
    Archive, RotateCcw, CheckCircle, Circle, Lock, Unlock
} from 'lucide-react';

const TaskCard = ({ task, onEdit, onDelete, onToggleStatus, onToggleActive, isSelected, onSelect }) => {
    const getRuleLabel = (type) => {
        switch (type) {
            case 'WEEKLY': return 'Weekly';
            case 'ONCE': return 'One-time';
            case 'EVERY_N_DAYS': return `Every ${task.interval_days} days`;
            case 'MONTHLY_DAY': return `Day ${task.month_day} monthly`;
            default: return type;
        }
    };

    const isArchived = !task.active;

    return (
        <div className={`glass-card p-5 flex items-center gap-6 group hover:border-white/10 transition-all 
            ${isSelected ? 'border-blue-500/50 bg-blue-500/5' : ''} 
            ${isArchived ? 'opacity-40 grayscale-[0.5]' : ''}`}>

            <div className="flex items-center">
                <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onSelect(task.task_id)}
                    className="w-5 h-5 rounded border-white/10 bg-white/5 cursor-pointer accent-blue-500"
                />
            </div>

            <div
                className="w-12 h-12 rounded-xl flex items-center justify-center font-bold bg-blue-500/10 text-blue-400 border border-blue-500/10"
            >
                {task.base_load_score.toFixed(1)}
            </div>

            <div className="flex-grow">
                <div className="flex items-center gap-3 mb-1">
                    <h4 className={`font-bold transition-all ${isArchived ? 'text-slate-500 italic' : ''}`}>
                        {task.task_name}
                    </h4>
                    <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/5 text-[10px] text-slate-400 uppercase tracking-widest font-bold">{task.context}</span>
                    {isArchived && <span className="text-[10px] text-amber-500/80 font-bold uppercase tracking-tighter">[Archived]</span>}
                </div>
                <div className="flex gap-4 text-xs text-slate-500">
                    <div className="flex items-center gap-1"><Clock size={12} /> {getRuleLabel(task.rule_type)}</div>
                    {task.due_date && <div className="flex items-center gap-1"><Calendar size={12} /> {task.due_date}</div>}
                    {task.is_locked && <div className="flex items-center gap-1 text-amber-500/80 font-bold"><Lock size={12} /> Locked</div>}
                </div>
            </div>

            <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-all">
                <button
                    onClick={() => onToggleActive(task)}
                    className={`p-2 rounded-lg transition-all ${isArchived ? 'hover:bg-blue-500/10 text-blue-400' : 'hover:bg-amber-500/10 text-slate-400 hover:text-amber-400'}`}
                    title={isArchived ? "Unarchive Task" : "Archive Task"}
                >
                    {isArchived ? <RotateCcw size={16} /> : <Archive size={16} />}
                </button>
                <button onClick={() => onEdit(task)} className={`p-2 hover:bg-white/5 rounded-lg transition-all ${task.is_locked ? 'text-amber-500' : 'text-slate-400 hover:text-white'}`} title={task.is_locked ? "Unlock & Edit" : "Edit Task"}>
                    {task.is_locked ? <Lock size={16} /> : <Edit2 size={16} />}
                </button>
                <button onClick={() => onDelete(task.task_id)} className="p-2 hover:bg-red-500/10 rounded-lg text-slate-400 hover:text-red-400" title="Delete Task" disabled={task.is_locked}><Trash2 size={16} /></button>
            </div>
        </div>
    );
};

const TaskManager = ({ token, apiKey }) => {
    const [tasks, setTasks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingTask, setEditingTask] = useState(null);
    const [isUploading, setIsUploading] = useState(false);
    const [selectedTaskIds, setSelectedTaskIds] = useState([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [filterActive, setFilterActive] = useState('ACTIVE'); // ALL, ACTIVE, ARCHIVED

    const filteredTasks = tasks.filter(t => {
        const matchesSearch = t.task_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            t.context.toLowerCase().includes(searchQuery.toLowerCase());
        const matchesActive = filterActive === 'ALL' ||
            (filterActive === 'ACTIVE' && t.active) ||
            (filterActive === 'ARCHIVED' && !t.active);
        return matchesSearch && matchesActive;
    });

    // Form State
    const [formData, setFormData] = useState({
        task_name: '', context: 'work', base_load_score: 2.0, rule_type: 'WEEKLY',
        mon: true, tue: true, wed: true, thu: true, fri: true, sat: false, sun: false,
        start_date: '', end_date: '', start_time: '', end_time: '', notes: '', is_locked: false,
        timezone: getTimezoneName()
    });

    const api = axios.create({
        baseURL: import.meta.env.VITE_API_BASE_URL || '/api/lbs',
        headers: {
            'Authorization': token ? `Bearer ${token}` : undefined,
            'X-API-Key': !token ? apiKey : undefined
        }
    });

    const fetchTasks = async () => {
        try {
            const resp = await api.get('/tasks');
            setTasks(resp.data);
            setLoading(false);
        } catch (err) {
            console.error(err);
            setLoading(false);
        }
    };

    useEffect(() => { if (token || apiKey) fetchTasks(); }, [token, apiKey]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        try {
            if (editingTask) {
                await api.put(`/tasks/${editingTask.task_id}?force_override=true`, formData);
            } else {
                await api.post('/tasks', formData);
            }
            setIsModalOpen(false);
            setEditingTask(null);
            fetchTasks();
        } catch (err) {
            alert("Error saving task: " + err.message);
        }
    };

    const handleEdit = (task) => {
        setEditingTask(task);
        setFormData({ timezone: getTimezoneName(), ...task });
        setIsModalOpen(true);
    };

    const handleDelete = async (id) => {
        if (window.confirm("Delete this task?")) {
            try {
                await api.delete(`/tasks/${id}?force_override=true`);
                fetchTasks();
                setSelectedTaskIds(prev => prev.filter(tid => tid !== id));
            } catch (err) {
                alert("Error deleting task: " + (err.response?.data?.detail || err.message));
            }
        }
    };

    const handleBulkDelete = async () => {
        if (window.confirm(`Delete ${selectedTaskIds.length} tasks?`)) {
            try {
                await api.post('/tasks/bulk-delete?force_override=true', { task_ids: selectedTaskIds });
                alert("Tasks deleted successfully");
                setSelectedTaskIds([]);
                fetchTasks();
            } catch (err) {
                alert("Error during bulk delete: " + (err.response?.data?.detail || err.message));
            }
        }
    };

    const toggleTaskSelection = (id) => {
        setSelectedTaskIds(prev =>
            prev.includes(id) ? prev.filter(tid => tid !== id) : [...prev, id]
        );
    };

    const handleToggleActive = async (task) => {
        try {
            await api.put(`/tasks/${task.task_id}?force_override=true`, { active: !task.active });
            fetchTasks();
        } catch (err) {
            alert("Error toggling active state: " + err.message);
        }
    };

    const handleBulkArchive = async (active = false) => {
        if (window.confirm(`${active ? 'Unarchive' : 'Archive'} ${selectedTaskIds.length} tasks?`)) {
            try {
                await api.post('/tasks/bulk-update-active', { task_ids: selectedTaskIds, active });
                setSelectedTaskIds([]);
                fetchTasks();
            } catch (err) {
                alert("Error during bulk operation: " + err.message);
            }
        }
    };

    const handleSelectAll = (e) => {
        if (e.target.checked) {
            const allFilteredIds = filteredTasks.map(t => t.task_id);
            // Union with existing selection to not lose manually selected hidden tasks
            setSelectedTaskIds(prev => [...new Set([...prev, ...allFilteredIds])]);
        } else {
            const filteredIdsSet = new Set(filteredTasks.map(t => t.task_id));
            setSelectedTaskIds(prev => prev.filter(id => !filteredIdsSet.has(id)));
        }
    };

    const handleExportCsv = (all = false) => {
        const tasksToExport = all ? tasks : tasks.filter(t => selectedTaskIds.includes(t.task_id));
        if (tasksToExport.length === 0) {
            alert("No tasks to export.");
            return;
        }

        const headers = [
            "task_name", "context", "base_load_score", "rule_type", "active", "status",
            "mon", "tue", "wed", "thu", "fri", "sat", "sun",
            "interval_days", "anchor_date", "month_day", "nth_in_month", "weekday_mon1",
            "start_date", "end_date", "start_time", "end_time", "due_date", "notes", "timezone"
        ];
        const csvContent = [headers.join(','), ...tasksToExport.map(t => headers.map(h => {
            const val = t[h];
            if (val === null || val === undefined) return "";
            // Escape strings containing commas or newlines
            if (typeof val === 'string' && (val.includes(',') || val.includes('\n') || val.includes('"'))) {
                return `"${val.replace(/"/g, '""')}"`;
            }
            return val;
        }).join(','))].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        const suffix = all ? 'all' : 'selected';
        link.setAttribute("download", `lbs_tasks_${suffix}_${getLocalISODateString()}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleCsvUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const formData = new FormData();
        formData.append('file', file);

        setIsUploading(true);
        try {
            await api.post('/tasks/upload-csv', formData, {
                headers: { 'Content-Type': 'multipart/form-data' }
            });
            alert("Tasks imported successfully!");
            fetchTasks();
        } catch (err) {
            alert("Error importing CSV: " + (err.response?.data?.detail || err.message));
        } finally {
            setIsUploading(false);
            e.target.value = ''; // Reset input
        }
    };

    return (
        <div className="flex flex-col gap-8">
            <header className="flex justify-between items-center">
                <div>
                    <h2 className="text-3xl font-bold mb-1">Task Inventory</h2>
                    <p className="text-slate-400">Manage master tasks and scheduling rules.</p>
                </div>
                <div className="flex gap-3">
                    {selectedTaskIds.length > 0 ? (
                        <>
                            <button
                                onClick={() => handleBulkArchive(false)}
                                className="bg-amber-500/10 text-amber-500 border border-amber-500/20 p-3 px-5 rounded-xl flex items-center gap-2 text-sm font-bold hover:bg-amber-500/20 transition-all"
                            >
                                <Archive size={18} /> Archive Selected
                            </button>
                            <button
                                onClick={handleBulkDelete}
                                className="bg-red-500/10 text-red-400 border border-red-500/20 p-3 px-5 rounded-xl flex items-center gap-2 text-sm font-bold hover:bg-red-500/20 transition-all"
                            >
                                <Trash2 size={18} /> Delete Selected
                            </button>
                        </>
                    ) : (
                        <>
                            <label className={`p-3 px-5 glass-card flex items-center gap-2 text-sm font-bold cursor-pointer hover:bg-white/5 transition-all ${isUploading ? 'opacity-50 pointer-events-none' : ''}`}>
                                <Upload size={18} className="text-blue-400" />
                                <span>{isUploading ? 'Importing...' : 'Import CSV'}</span>
                                <input type="file" accept=".csv" className="hidden" onChange={handleCsvUpload} />
                            </label>
                            <button
                                onClick={() => { setEditingTask(null); setIsModalOpen(true); }}
                                className="primary flex items-center gap-2"
                            >
                                <Plus size={20} /> Create Task
                            </button>
                        </>
                    )}
                </div>
            </header>

            <div className="flex flex-wrap gap-4 mb-4 items-center">
                <div className="flex-grow min-w-[300px] relative">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
                    <input
                        className="w-full pl-12 bg-white/5 border-white/5 h-12"
                        placeholder="Search tasks or contexts..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                </div>

                <div className="flex bg-white/5 p-1 rounded-xl border border-white/10 h-10 items-center">
                    <button
                        onClick={() => setFilterActive('ACTIVE')}
                        className={`px-4 h-full rounded-lg text-xs font-bold uppercase transition-all ${filterActive === 'ACTIVE' ? 'bg-blue-500 text-white' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                        Active
                    </button>
                    <button
                        onClick={() => setFilterActive('ARCHIVED')}
                        className={`px-4 h-full rounded-lg text-xs font-bold uppercase transition-all ${filterActive === 'ARCHIVED' ? 'bg-amber-500 text-white' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                        Archived
                    </button>
                    <button
                        onClick={() => setFilterActive('ALL')}
                        className={`px-4 h-full rounded-lg text-xs font-bold uppercase transition-all ${filterActive === 'ALL' ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                        All
                    </button>
                </div>

                <div className="flex bg-white/5 p-1 rounded-xl border border-white/10 h-10 items-center">
                    {selectedTaskIds.length > 0 && <button onClick={() => handleExportCsv(false)} className="p-2 text-emerald-400 hover:blue-500" title="Export Selected"><Download size={18} /></button>}
                    {selectedTaskIds.length === 0 && <button onClick={() => handleExportCsv(true)} className="p-2 text-emerald-400 hover:text-white transition-all" title="Export All Tasks"><Download size={18} /></button>}
                </div>

                <button
                    className="p-2 px-4 glass-card flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-all h-10"
                    onClick={() => { setSearchQuery(''); setFilterActive('ACTIVE'); }}
                >
                    Reset
                </button>
            </div>

            <div className="flex flex-col gap-3">
                <div className="flex items-center gap-4 px-5 py-2">
                    <input
                        type="checkbox"
                        checked={filteredTasks.length > 0 && filteredTasks.every(t => selectedTaskIds.includes(t.task_id))}
                        onChange={handleSelectAll}
                        className="w-5 h-5 rounded border-white/10 bg-white/5 cursor-pointer accent-blue-500"
                    />
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">Select All Visible</span>
                </div>

                {loading ? <div className="p-20 text-center text-slate-500">Loading tasks...</div> :
                    filteredTasks.length === 0 ? <div className="p-20 text-center text-slate-500 glass-card">No tasks found matching your criteria.</div> :
                        filteredTasks.map(t => (
                            <TaskCard
                                key={t.task_id}
                                task={t}
                                onEdit={handleEdit}
                                onDelete={handleDelete}
                                onToggleActive={handleToggleActive}
                                isSelected={selectedTaskIds.includes(t.task_id)}
                                onSelect={toggleTaskSelection}
                            />
                        ))
                }
            </div>

            {/* Task Modal */}
            {isModalOpen && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-6">
                    <form onSubmit={handleSubmit} className="glass-card p-10 w-full max-w-xl flex flex-col gap-6 overflow-y-auto max-h-[90vh]">
                        <h3 className="text-2xl font-bold">{editingTask ? 'Edit Task' : 'New LBS Task'}</h3>

                        <div className="grid grid-cols-2 gap-4">
                            <div className="col-span-2">
                                <label className="block text-xs text-slate-500 uppercase font-bold tracking-widest mb-2">Task Name</label>
                                <input
                                    required className="w-full"
                                    value={formData.task_name}
                                    onChange={e => setFormData({ ...formData, task_name: e.target.value })}
                                />
                            </div>
                            <div className="">
                                <label className="block text-xs text-slate-500 uppercase font-bold tracking-widest mb-2">Context (Spoke)</label>
                                <input
                                    required className="w-full"
                                    value={formData.context}
                                    onChange={e => setFormData({ ...formData, context: e.target.value.toLowerCase() })}
                                />
                            </div>
                            <div className="">
                                <label className="block text-xs text-slate-500 uppercase font-bold tracking-widest mb-2">Timezone</label>
                                <input
                                    className="w-full"
                                    placeholder="e.g. Asia/Tokyo"
                                    value={formData.timezone || ''}
                                    onChange={e => setFormData({ ...formData, timezone: e.target.value })}
                                />
                            </div>
                            <div className="col-span-2">
                                <label className="block text-xs text-slate-500 uppercase font-bold tracking-widest mb-2">Base Load Score (0-10)</label>
                                <input
                                    type="number" step="0.5" min="0" max="10" required className="w-full"
                                    value={formData.base_load_score}
                                    onChange={e => setFormData({ ...formData, base_load_score: parseFloat(e.target.value) })}
                                />
                            </div>

                            <div className="col-span-2">
                                <label className="block text-xs text-slate-500 uppercase font-bold tracking-widest mb-2">Recurrence Rule</label>
                                <select
                                    className="w-full"
                                    value={formData.rule_type}
                                    onChange={e => setFormData({ ...formData, rule_type: e.target.value })}
                                >
                                    <option value="WEEKLY">Weekly (specific days)</option>
                                    <option value="ONCE">One-time</option>
                                    <option value="EVERY_N_DAYS">Interval (Every N days)</option>
                                    <option value="MONTHLY_DAY">Monthly (Specific day)</option>
                                </select>
                            </div>

                            {formData.rule_type === 'WEEKLY' && (
                                <div className="col-span-2 flex justify-between gap-1 mt-2">
                                    {['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(day => (
                                        <button
                                            key={day} type="button"
                                            onClick={() => setFormData({ ...formData, [day]: !formData[day] })}
                                            className={`w-10 h-10 rounded-lg text-[10px] font-bold uppercase transition-all ${formData[day] ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/20' : 'bg-white/5 text-slate-500'}`}
                                        >
                                            {day.slice(0, 3)}
                                        </button>
                                    ))}
                                </div>
                            )}

                            {formData.rule_type === 'ONCE' && (
                                <div className="col-span-2">
                                    <label className="block text-xs text-slate-500 uppercase font-bold tracking-widest mb-2">Due Date</label>
                                    <input
                                        type="date" required className="w-full"
                                        value={formData.due_date || ''}
                                        onChange={e => setFormData({ ...formData, due_date: e.target.value })}
                                    />
                                </div>
                            )}

                            {formData.rule_type === 'EVERY_N_DAYS' && (
                                <div className="grid grid-cols-2 gap-4 col-span-2">
                                    <div>
                                        <label className="block text-xs text-slate-500 uppercase font-bold tracking-widest mb-2">Interval (Days)</label>
                                        <input
                                            type="number" min="1" required className="w-full"
                                            value={formData.interval_days || 1}
                                            onChange={e => setFormData({ ...formData, interval_days: parseInt(e.target.value) })}
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-slate-500 uppercase font-bold tracking-widest mb-2">Anchor Date</label>
                                        <input
                                            type="date" required className="w-full"
                                            value={formData.anchor_date || ''}
                                            onChange={e => setFormData({ ...formData, anchor_date: e.target.value })}
                                        />
                                    </div>
                                </div>
                            )}

                            {formData.rule_type === 'MONTHLY_DAY' && (
                                <div className="col-span-2">
                                    <label className="block text-xs text-slate-500 uppercase font-bold tracking-widest mb-2">Day of Month (1-31)</label>
                                    <input
                                        type="number" min="1" max="31" required className="w-full"
                                        value={formData.month_day || 1}
                                        onChange={e => setFormData({ ...formData, month_day: parseInt(e.target.value) })}
                                    />
                                </div>
                            )}

                            <div className="grid grid-cols-2 gap-4 col-span-2 pt-4 border-t border-white/5">
                                <div>
                                    <label className="block text-xs text-slate-500 uppercase font-bold tracking-widest mb-2">Start Date (Optional)</label>
                                    <input
                                        type="date" className="w-full"
                                        value={formData.start_date || ''}
                                        onChange={e => setFormData({ ...formData, start_date: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs text-slate-500 uppercase font-bold tracking-widest mb-2">End Date (Optional)</label>
                                    <input
                                        type="date" className="w-full"
                                        value={formData.end_date || ''}
                                        onChange={e => setFormData({ ...formData, end_date: e.target.value })}
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4 col-span-2 pt-4 border-t border-white/5">
                                <div>
                                    <label className="block text-xs text-slate-500 uppercase font-bold tracking-widest mb-2">Start Time (Optional)</label>
                                    <input
                                        type="time" className="w-full" step="1"
                                        value={formData.start_time || ''}
                                        onChange={e => setFormData({ ...formData, start_time: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs text-slate-500 uppercase font-bold tracking-widest mb-2">End Time (Optional)</label>
                                    <input
                                        type="time" className="w-full" step="1"
                                        value={formData.end_time || ''}
                                        onChange={e => setFormData({ ...formData, end_time: e.target.value })}
                                    />
                                </div>
                            </div>

                            <div className="col-span-2 p-4 rounded-xl bg-amber-500/5 border border-amber-500/10 flex items-center justify-between">
                                <div className="flex items-baseline gap-2">
                                    <h4 className="font-bold text-sm text-amber-500 flex items-center gap-2">
                                        <Lock size={14} /> Lock Task Configuration
                                    </h4>
                                    <p className="text-[10px] text-slate-500 uppercase font-bold tracking-widest text-wrap">Prevent unintended modifications or deletions</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setFormData({ ...formData, is_locked: !formData.is_locked })}
                                    className={`w-12 h-6 rounded-full transition-all relative flex-shrink-0 ${formData.is_locked ? 'bg-amber-500' : 'bg-white/10'}`}
                                >
                                    <div className={`w-5 h-5 rounded-full bg-white absolute top-0.5 transition-all ${formData.is_locked ? 'left-6' : 'left-0.5'}`} />
                                </button>
                            </div>

                            <div className="col-span-2">
                                <label className="block text-xs text-slate-500 uppercase font-bold tracking-widest mb-2">Notes</label>
                                <textarea
                                    className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm min-h-[100px] focus:border-blue-500/50 transition-all"
                                    placeholder="Additional task details or instructions..."
                                    value={formData.notes || ''}
                                    onChange={e => setFormData({ ...formData, notes: e.target.value })}
                                />
                            </div>
                        </div>

                        <div className="flex gap-4 pt-4 border-t border-white/5">
                            <button type="button" onClick={() => setIsModalOpen(false)} className="px-6 py-2 text-slate-400 hover:text-white">Cancel</button>
                            <button type="submit" className="primary flex-grow">Save Task Rule</button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
};

export default TaskManager;
