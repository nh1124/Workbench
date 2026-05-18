import { getLocalISODateString } from '../utils/date';
import React, { useState, useEffect } from 'react';
import axios from 'axios';
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area,
    LineChart, Line
} from 'recharts';
import { Activity, ShieldCheck, Zap, AlertTriangle, CheckCircle2, Circle, XCircle } from 'lucide-react';

const KPICard = ({ icon: Icon, label, value, subtext, color }) => (
    <div className="glass-card p-6 flex flex-col gap-2">
        <div className="flex justify-between items-start">
            <div className="text-slate-400 text-sm font-medium">{label}</div>
            <div className={`p-2 rounded-lg bg-${color}/10 text-${color}`}>
                <Icon size={18} />
            </div>
        </div>
        <div className="text-3xl font-bold">{value}</div>
        <div className="text-[10px] text-slate-500 uppercase tracking-wider">{subtext}</div>
    </div>
);

const Dashboard = ({ token, apiKey }) => {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [trendStartDate, setTrendStartDate] = useState(getLocalISODateString());

    const api = axios.create({
        baseURL: import.meta.env.VITE_API_BASE_URL || '/api/lbs',
        headers: {
            'Authorization': token ? `Bearer ${token}` : undefined,
            'X-API-Key': !token ? apiKey : undefined
        }
    });

    useEffect(() => {
        const fetchData = async () => {
            try {
                setLoading(true);
                const statusParams = "status=todo&status=done&status=skipped";
                const [dashResp, trendsResp] = await Promise.all([
                    api.get(`/dashboard`),
                    api.get(`/trends?weeks=4&start_date=${trendStartDate}&${statusParams}`)
                ]);
                setData({ ...dashResp.data, trends: trendsResp.data.trends });
                setLoading(false);
            } catch (err) {
                setError(err.message);
                setLoading(false);
            }
        };
        if (token || apiKey) fetchData();
    }, [token, apiKey, trendStartDate]);

    if (loading) return <div className="flex items-center justify-center h-full text-slate-500 animate-pulse">Initializing Dashboard...</div>;
    if (error) return <div className="text-red-400 p-8 glass-card">Error: {error}. Make sure backend is running on the configured port.</div>;

    const getLevelColor = (level) => {
        switch (level) {
            case 'SAFE': return '#10b981';
            case 'WARNING': return '#f59e0b';
            case 'DANGER': return '#ef4444';
            case 'CRITICAL': return '#8b5cf6';
            default: return '#3b82f6';
        }
    };

    return (
        <div className="flex flex-col gap-8">
            <header className="flex justify-between items-end">
                <div>
                    <h2 className="text-3xl font-bold mb-1">System Overview</h2>
                    <p className="text-slate-400">Real-time cognitive load analysis and predictions.</p>
                </div>
                <div className="flex gap-4">
                    <div className="text-right">
                        <div className="text-xs text-slate-500 uppercase font-bold tracking-widest">Daily Capacity</div>
                        <div className="text-lg font-bold text-blue-400">{data.config.CAP}.0 Units</div>
                    </div>
                </div>
            </header>

            {/* KPI Row */}
            <div className="grid grid-cols-4 gap-6">
                <KPICard
                    icon={ShieldCheck}
                    label="Recovery Rate"
                    value={`${(data.weekly?.average_load || 0) < 6 ? 'High' : 'Optimal'}`}
                    subtext={`${data.weekly?.recovery_rate || 0}% safe days`}
                    color="emerald-500"
                />
                <KPICard
                    icon={Activity}
                    label="Weekly Avg"
                    value={(data.weekly?.average_load || 0).toFixed(1)}
                    subtext="units per day"
                    color="blue-500"
                />
                <KPICard
                    icon={AlertTriangle}
                    label="Overload Index"
                    value={data.today?.is_overflow ? "High" : "Low"}
                    color="amber-500"
                />
                <KPICard
                    icon={Zap}
                    label="Active Tasks"
                    value={data.today.task_count}
                    subtext="scheduled for today"
                    color="purple-500"
                />
            </div>

            <div className="grid grid-cols-3 gap-8">
                {/* Heatmap Section */}
                <div className="col-span-2 glass-card p-6">
                    <div className="flex justify-between items-center mb-6">
                        <h3 className="font-bold text-lg">Load Distribution</h3>
                        <div className="flex gap-2 text-[10px] text-slate-500">
                            <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-[#10b981]"></div> Safe</div>
                            <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-[#f59e0b]"></div> Warn</div>
                            <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-[#ef4444]"></div> Danger</div>
                            <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-[#8b5cf6]"></div> Peak</div>
                        </div>
                    </div>
                    <div className="grid grid-cols-7 gap-3">
                        {data.daily_breakdown.map((day, i) => (
                            <div key={i} className="flex flex-col gap-2">
                                <div className="text-[10px] text-center text-slate-500 font-bold uppercase">
                                    {new Date(day.date).toLocaleDateString('en-US', { weekday: 'short' })}
                                </div>
                                <div
                                    className="h-24 rounded-xl flex flex-col items-center justify-center gap-1 transition-all hover:scale-105"
                                    style={{ background: `${getLevelColor(day.level)}22`, border: `1px solid ${getLevelColor(day.level)}44` }}
                                >
                                    <div className="text-xl font-bold" style={{ color: getLevelColor(day.level) }}>{day.adjusted_load.toFixed(1)}</div>
                                    <div className="text-[10px] opacity-60 font-medium">Tasks: {day.task_count}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Capacity View */}
                <div className="glass-card p-6 flex flex-col gap-6">
                    <h3 className="font-bold text-lg">Today's Context</h3>
                    <div className="flex-grow flex flex-col items-center justify-center gap-4">
                        <div className="relative w-32 h-32">
                            <svg className="w-full h-full transform -rotate-90">
                                <circle
                                    cx="64" cy="64" r="58"
                                    fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="8"
                                />
                                <circle
                                    cx="64" cy="64" r="58"
                                    fill="none" stroke="url(#blue_grad)" strokeWidth="8"
                                    strokeDasharray={364}
                                    strokeDashoffset={364 - (364 * Math.min(data.today.adjusted_load / data.config.CAP, 1))}
                                    strokeLinecap="round"
                                />
                                <defs>
                                    <linearGradient id="blue_grad" x1="0%" y1="0%" x2="100%" y2="100%">
                                        <stop offset="0%" stopColor="#3b82f6" />
                                        <stop offset="100%" stopColor="#8b5cf6" />
                                    </linearGradient>
                                </defs>
                            </svg>
                            <div className="absolute inset-0 flex flex-col items-center justify-center">
                                <div className="text-2xl font-bold">{((data.today.adjusted_load / data.config.CAP) * 100).toFixed(0)}%</div>
                                <div className="text-[10px] text-slate-500 font-bold">LOAD</div>
                            </div>
                        </div>
                        <div className="text-center">
                            <div className="text-sm font-medium text-slate-300">Remaining capacity:</div>
                            <div className="text-lg font-bold text-emerald-400">{Math.max(data.config.CAP - data.today.adjusted_load, 0).toFixed(1)} Units</div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-3 gap-8">
                <div className="col-span-2 glass-card p-8">
                    <div className="flex justify-between items-center mb-8">
                        <h3 className="font-bold text-lg">4-Week Prediction Trend</h3>
                        <div className="flex items-center gap-4 bg-white/5 p-2 rounded-xl border border-white/5">
                            <button
                                onClick={() => {
                                    const d = new Date(trendStartDate);
                                    d.setDate(d.getDate() - 28);
                                    setTrendStartDate(getLocalISODateString(d));
                                }}
                                className="p-1 hover:bg-white/5 rounded text-slate-400 hover:text-white transition-all text-xs"
                            >
                                Previous 4W
                            </button>
                            <span className="text-xs font-bold text-slate-300">
                                Range: {new Date(trendStartDate).toLocaleDateString()} - {new Date(new Date(trendStartDate).getTime() + 28 * 24 * 60 * 60 * 1000).toLocaleDateString()}
                            </span>
                            <button
                                onClick={() => {
                                    const d = new Date(trendStartDate);
                                    d.setDate(d.getDate() + 28);
                                    setTrendStartDate(getLocalISODateString(d));
                                }}
                                className="p-1 hover:bg-white/5 rounded text-slate-400 hover:text-white transition-all text-xs"
                            >
                                Next 4W
                            </button>
                        </div>
                    </div>
                    <div className="h-64 w-full">
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={data.trends}>
                                <defs>
                                    <linearGradient id="colorLoad" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.05)" />
                                <XAxis dataKey="date" stroke="#475569" fontSize={11} tickFormatter={(str) => new Date(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} />
                                <YAxis stroke="#475569" fontSize={11} domain={[0, 12]} />
                                <Tooltip
                                    contentStyle={{ background: '#1a1a1f', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px' }}
                                    itemStyle={{ color: '#3b82f6' }}
                                />
                                <Area type="monotone" dataKey="average_load" stroke="#3b82f6" strokeWidth={3} fillOpacity={1} fill="url(#colorLoad)" />
                                <Line type="monotone" dataKey="max_load" stroke="#8b5cf6" strokeDasharray="5 5" dot={false} />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>
                </div>

                {/* Today's Tasks Widget */}
                <div className="glass-card p-6 flex flex-col overflow-hidden">
                    <div className="flex justify-between items-center mb-4 flex-shrink-0">
                        <h3 className="font-bold text-lg">Today's Tasks</h3>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 font-bold uppercase tracking-wider">
                            {data.today.tasks.length} Total
                        </span>
                    </div>
                    <div className="flex flex-col gap-2 overflow-y-auto flex-1 pr-1 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent hover:scrollbar-thumb-white/20">
                        {data.today.tasks.length === 0 ? (
                            <div className="text-center py-10 text-slate-500 text-sm">No tasks for today.</div>
                        ) : (
                            data.today.tasks.map((task, idx) => {
                                const isDone = task.status === 'done';
                                const isSkipped = task.status === 'skipped';
                                return (
                                    <div key={idx} className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/5 group hover:bg-white/10 transition-all flex-shrink-0">
                                        <div className="flex flex-col gap-0.5 min-w-0 flex-1 mr-2">
                                            <span className={`text-sm font-bold truncate ${isDone ? 'text-emerald-400/70 line-through' : 'text-slate-200'}`}>
                                                {task.task_name}
                                            </span>
                                            <div className="flex items-center gap-2">
                                                <span className="text-[9px] text-slate-500 uppercase font-bold tracking-widest truncate">{task.context}</span>
                                                {task.status !== 'todo' && (
                                                    <span className={`text-[8px] px-1 py-0.25 rounded-full font-bold uppercase flex-shrink-0 ${isDone ? 'bg-emerald-500/20 text-emerald-400' : isSkipped ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400'}`}>
                                                        {task.status}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        <div className={`p-1.5 rounded-lg flex-shrink-0 ${isDone ? 'text-emerald-400' : isSkipped ? 'text-amber-400' : 'text-slate-600'}`}>
                                            {isDone ? <CheckCircle2 size={16} /> : isSkipped ? <XCircle size={16} /> : <Circle size={16} />}
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Dashboard;
