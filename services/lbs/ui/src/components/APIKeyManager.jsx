import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Key, Plus, Trash2, Shield, Clock, ExternalLink, Copy, Check } from 'lucide-react';

const APIKeyManager = ({ jwt }) => {
    const [keys, setKeys] = useState([]);
    const [loading, setLoading] = useState(true);
    const [isCreating, setIsCreating] = useState(false);
    const [newKeyData, setNewKeyData] = useState({ client_id: '', scopes: ['read'] });
    const [revealedKey, setRevealedKey] = useState(null);
    const [copied, setCopied] = useState(false);

    const apiBase = import.meta.env.VITE_API_BASE_URL || '/api/lbs';
    const api = axios.create({
        baseURL: apiBase,
        headers: { 'Authorization': `Bearer ${jwt}` }
    });

    const fetchKeys = async () => {
        try {
            setLoading(true);
            const resp = await api.get('/auth/api-keys');
            setKeys(resp.data);
        } catch (err) {
            console.error('Failed to fetch API keys', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (jwt) fetchKeys();
    }, [jwt]);

    const handleCreate = async (e) => {
        e.preventDefault();
        try {
            const resp = await api.post('/auth/api-keys', newKeyData);
            setRevealedKey(resp.data.api_key);
            fetchKeys();
            setIsCreating(false);
            setNewKeyData({ client_id: '', scopes: ['read'] });
        } catch (err) {
            alert(err.response?.data?.detail || 'Failed to create key');
        }
    };

    const handleRevoke = async (id) => {
        if (!window.confirm('Are you sure you want to revoke this API key? This action cannot be undone.')) return;
        try {
            await api.delete(`/auth/api-keys/${id}`);
            fetchKeys();
        } catch (err) {
            alert('Failed to revoke key');
        }
    };

    const copyToClipboard = (text) => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    if (loading && keys.length === 0) return <div className="p-10 text-center text-slate-500 animate-pulse">Loading Keys...</div>;

    return (
        <div className="flex flex-col gap-6">
            <div className="flex justify-between items-center">
                <div>
                    <h3 className="text-xl font-bold text-white">API Access Keys</h3>
                    <p className="text-xs text-slate-500 mt-1 uppercase tracking-widest font-bold">M2M / Automation Only</p>
                </div>
                <button
                    onClick={() => { setIsCreating(true); setRevealedKey(null); }}
                    className="p-2 px-4 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400 hover:bg-blue-500/20 transition-all flex items-center gap-2 text-sm font-bold"
                >
                    <Plus size={16} /> Generate Key
                </button>
            </div>

            {revealedKey && (
                <div className="p-6 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl flex flex-col gap-4 animate-in fade-in slide-in-from-top-4 duration-500">
                    <div className="flex items-center gap-3 text-emerald-400">
                        <Shield size={20} />
                        <span className="font-bold">New API Key Generated</span>
                    </div>
                    <p className="text-xs text-emerald-400/70">
                        Copy this key now. For your security, <span className="underline">it will never be shown again</span>.
                    </p>
                    <div className="flex gap-2">
                        <div className="flex-grow bg-black/40 p-4 rounded-xl font-mono text-sm break-all text-white border border-white/5 select-all">
                            {revealedKey}
                        </div>
                        <button
                            onClick={() => copyToClipboard(revealedKey)}
                            className="p-4 bg-emerald-500 text-white rounded-xl hover:bg-emerald-600 transition-all flex items-center justify-center min-w-[56px]"
                        >
                            {copied ? <Check size={20} /> : <Copy size={20} />}
                        </button>
                    </div>
                    <button
                        onClick={() => setRevealedKey(null)}
                        className="text-[10px] uppercase font-bold text-emerald-400/50 hover:text-emerald-400 transition-all self-end"
                    >
                        I have saved the key securely
                    </button>
                </div>
            )}

            <div className="grid gap-4">
                {keys.length === 0 ? (
                    <div className="p-12 border-2 border-dashed border-white/5 rounded-2xl text-center text-slate-500 flex flex-col items-center gap-4">
                        <Key size={32} className="opacity-20" />
                        <div className="text-sm">No active API keys found. Generate one for automation.</div>
                    </div>
                ) : (
                    keys.map(key => (
                        <div key={key.id} className={`glass-card p-5 flex items-center gap-6 group ${!key.is_active ? 'opacity-50 grayscale' : ''}`}>
                            <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${key.is_active ? 'bg-blue-500/10 text-blue-400' : 'bg-slate-800 text-slate-500'}`}>
                                <Key size={24} />
                            </div>
                            <div className="flex-grow">
                                <div className="flex items-center gap-3 mb-1">
                                    <h4 className="font-bold text-white">{key.client_id}</h4>
                                    {key.is_active ? (
                                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[10px] text-emerald-400 font-bold uppercase tracking-widest">Active</span>
                                    ) : (
                                        <span className="px-2 py-0.5 rounded-full bg-red-500/10 border border-red-500/20 text-[10px] text-red-500 font-bold uppercase tracking-widest">Revoked</span>
                                    )}
                                </div>
                                <div className="flex gap-4 text-[10px] text-slate-500 uppercase tracking-widest font-bold">
                                    <div className="flex items-center gap-1"><Clock size={12} /> Created: {new Date(key.created_at).toLocaleDateString()}</div>
                                    {key.last_used_at && <div className="flex items-center gap-1"><ExternalLink size={12} /> Used: {new Date(key.last_used_at).toLocaleString()}</div>}
                                </div>
                            </div>
                            <div className="flex items-center gap-3">
                                <div className="flex flex-col items-end">
                                    <div className="flex gap-1">
                                        {key.scopes.map(s => <span key={s} className="px-2 py-0.5 rounded-md bg-white/5 text-[10px] text-slate-400 font-mono">{s}</span>)}
                                    </div>
                                    {key.expires_at && <div className="text-[9px] text-amber-500/70 mt-1">Exp: {new Date(key.expires_at).toLocaleDateString()}</div>}
                                </div>
                                {key.is_active && (
                                    <button
                                        onClick={() => handleRevoke(key.id)}
                                        className="p-3 hover:bg-red-500/10 rounded-xl text-slate-500 hover:text-red-400 transition-all ml-2"
                                    >
                                        <Trash2 size={18} />
                                    </button>
                                )}
                            </div>
                        </div>
                    ))
                )}
            </div>

            {isCreating && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-[110]">
                    <form onSubmit={handleCreate} className="glass-card p-10 w-[450px] flex flex-col gap-6 shadow-2xl border-white/10">
                        <h3 className="text-2xl font-bold text-white">Generate M2M Key</h3>

                        <div className="flex flex-col gap-2">
                            <label className="text-xs font-bold text-slate-500 uppercase tracking-widest pl-1">Client Identifier</label>
                            <input
                                required
                                className="w-full bg-white/5 border-white/10 hover:border-white/20 transition-all text-white h-12 rounded-xl"
                                placeholder="e.g. hub-agent, python-script-1"
                                value={newKeyData.client_id}
                                onChange={e => setNewKeyData({ ...newKeyData, client_id: e.target.value })}
                            />
                        </div>

                        <div className="flex flex-col gap-2">
                            <label className="text-xs font-bold text-slate-500 uppercase tracking-widest pl-1">Scopes</label>
                            <div className="flex gap-3">
                                {['read', 'write'].map(scope => (
                                    <button
                                        key={scope}
                                        type="button"
                                        onClick={() => {
                                            const newScopes = newKeyData.scopes.includes(scope)
                                                ? newKeyData.scopes.filter(s => s !== scope)
                                                : [...newKeyData.scopes, scope];
                                            setNewKeyData({ ...newKeyData, scopes: newScopes });
                                        }}
                                        className={`flex-grow p-3 rounded-xl border text-sm font-bold transition-all ${newKeyData.scopes.includes(scope)
                                                ? 'bg-blue-500/20 border-blue-500 text-blue-400'
                                                : 'bg-white/5 border-white/10 text-slate-500'
                                            }`}
                                    >
                                        {scope.toUpperCase()}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="flex gap-4 pt-4">
                            <button
                                type="button"
                                onClick={() => setIsCreating(false)}
                                className="flex-grow h-12 rounded-xl text-slate-400 hover:text-white transition-all font-bold"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                className="primary flex-grow h-12 rounded-xl font-bold"
                            >
                                Generate Key
                            </button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
};

export default APIKeyManager;
