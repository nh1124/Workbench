import { getLocalISODateString } from '../utils/date';
import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Save, Trash2, Calendar, AlertCircle, Thermometer, Brain, Activity } from 'lucide-react';

const ConditionManager = ({ token }) => {
    const [conditions, setConditions] = useState([]);
    const [loading, setLoading] = useState(false);
    const [formData, setFormData] = useState({
        date: getLocalISODateString(),
        cognitive_fatigue: 0,
        physical_fatigue: 0,
        note: ''
    });

    const apiBase = import.meta.env.VITE_API_BASE_URL || '/api/lbs';
    const headers = { 'Authorization': `Bearer ${token}` };

    useEffect(() => {
        fetchConditions();
    }, []);

    const fetchConditions = async () => {
        try {
            setLoading(true);
            const start = new Date();
            start.setDate(start.getDate() - 30);
            const end = new Date();
            end.setDate(end.getDate() + 7);

            const resp = await axios.get(`${apiBase}/conditions`, {
                params: {
                    start_date: getLocalISODateString(start),
                    end_date: getLocalISODateString(end)
                },
                headers
            });
            setConditions(resp.data.sort((a, b) => new Date(b.target_date) - new Date(a.target_date)));
        } catch (err) {
            console.error('Failed to fetch conditions:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        try {
            await axios.post(`${apiBase}/conditions`, formData, { headers });
            setFormData({ ...formData, note: '' });
            fetchConditions();
            alert('Condition updated successfully');
        } catch (err) {
            alert('Failed to update condition: ' + (err.response?.data?.detail || err.message));
        }
    };

    const handleDelete = async (date) => {
        if (!window.confirm(`Reset condition for ${date}?`)) return;
        try {
            await axios.delete(`${apiBase}/conditions/${date}`, { headers });
            fetchConditions();
        } catch (err) {
            alert('Failed to delete condition');
        }
    };

    const renderFatigueSlider = (label, field, Icon) => (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[10px] text-slate-500 uppercase tracking-widest font-bold">
                <Icon size={12} />
                {label} (Level {formData[field]})
            </div>
            <input
                type="range"
                min="0"
                max="5"
                step="1"
                value={formData[field]}
                onChange={(e) => setFormData({ ...formData, [field]: parseInt(e.target.value) })}
                className="w-full h-1.5 bg-white/5 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
            <div className="flex justify-between text-[10px] text-slate-600 px-1">
                <span>Normal</span>
                <span>Exhausted</span>
            </div>
        </div>
    );

    return (
        <div className="max-w-4xl mx-auto flex flex-col gap-10">
            <section>
                <h2 className="text-3xl font-bold mb-8">Daily Condition</h2>
                <div className="glass-card p-8">
                    <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-8">
                        <div className="flex flex-col gap-6">
                            <div className="flex flex-col gap-2">
                                <label className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Target Date</label>
                                <div className="relative">
                                    <Calendar className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
                                    <input
                                        type="date"
                                        required
                                        value={formData.date}
                                        onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                                        className="w-full bg-white/5 border-white/10 pl-12 h-12 rounded-xl text-white"
                                    />
                                </div>
                            </div>

                            {renderFatigueSlider('Cognitive Fatigue', 'cognitive_fatigue', Brain)}
                            {renderFatigueSlider('Physical Fatigue', 'physical_fatigue', Activity)}
                        </div>

                        <div className="flex flex-col gap-6">
                            <div className="flex flex-col gap-2 h-full">
                                <label className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Notes</label>
                                <textarea
                                    value={formData.note}
                                    onChange={(e) => setFormData({ ...formData, note: e.target.value })}
                                    placeholder="How are you feeling today?"
                                    className="flex-grow bg-white/5 border-white/10 rounded-xl p-4 text-white resize-none text-sm min-h-[120px]"
                                />
                            </div>

                            <button type="submit" className="primary h-14 rounded-2xl font-bold flex items-center justify-center gap-2">
                                <Save size={20} />
                                Save Condition
                            </button>
                        </div>
                    </form>
                </div>
            </section>

            <section>
                <div className="flex justify-between items-center mb-8">
                    <h2 className="text-2xl font-bold">Recent History</h2>
                    <button
                        onClick={fetchConditions}
                        className="text-xs text-blue-400 hover:text-blue-300 transition-all font-bold uppercase tracking-widest"
                    >
                        Refresh
                    </button>
                </div>

                <div className="flex flex-col gap-4">
                    {loading ? (
                        <div className="text-center p-12 text-slate-500 italic">Updating history...</div>
                    ) : conditions.length === 0 ? (
                        <div className="glass-card p-12 text-center text-slate-500 text-sm">
                            No fatigue records found for the last 30 days. All systems running at 100% capacity.
                        </div>
                    ) : (
                        conditions.map((item) => (
                            <div key={item.target_date} className="glass-card p-6 flex items-center justify-between group">
                                <div className="flex items-center gap-6">
                                    <div className="flex flex-col">
                                        <span className="text-sm font-bold text-white">{item.target_date}</span>
                                        <span className="text-[10px] text-slate-500 font-mono">
                                            {new Date(item.updated_at).toLocaleTimeString()}
                                        </span>
                                    </div>

                                    <div className="h-8 w-[1px] bg-white/5"></div>

                                    <div className="flex gap-4">
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] text-slate-500 uppercase font-bold">Cognitive</span>
                                            <div className="flex gap-1">
                                                {[1, 2, 3, 4, 5].map((level) => (
                                                    <div
                                                        key={level}
                                                        className={`w-3 h-1.5 rounded-full ${level <= item.cognitive_fatigue ? 'bg-blue-500' : 'bg-white/5'}`}
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] text-slate-500 uppercase font-bold">Physical</span>
                                            <div className="flex gap-1">
                                                {[1, 2, 3, 4, 5].map((level) => (
                                                    <div
                                                        key={level}
                                                        className={`w-3 h-1.5 rounded-full ${level <= item.physical_fatigue ? 'bg-purple-500' : 'bg-white/5'}`}
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                    </div>

                                    {item.note && (
                                        <>
                                            <div className="h-8 w-[1px] bg-white/5"></div>
                                            <div className="text-xs text-slate-400 italic max-w-md truncate">
                                                "{item.note}"
                                            </div>
                                        </>
                                    )}
                                </div>

                                <button
                                    onClick={() => handleDelete(item.target_date)}
                                    className="p-3 text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all rounded-xl hover:bg-red-500/10"
                                >
                                    <Trash2 size={18} />
                                </button>
                            </div>
                        ))
                    )}
                </div>
            </section>

            <div className="p-6 bg-blue-500/10 border border-blue-500/20 rounded-2xl flex gap-4 items-start">
                <AlertCircle className="text-blue-400 shrink-0 mt-0.5" size={20} />
                <div>
                    <h4 className="text-sm font-bold text-blue-200 mb-1">Impact Analysis (B+C Model)</h4>
                    <p className="text-xs text-blue-300/80 leading-relaxed">
                        Cognitive fatigue levels significantly reduce your effective processing capacity.
                        <br />
                        • <b>Efficiency Loss:</b> Total load is increased by 20% per level.
                        <br />
                        • <b>Capacity Decay:</b> Effective cap is reduced by 10% per level.
                    </p>
                </div>
            </div>
        </div>
    );
};

export default ConditionManager;
