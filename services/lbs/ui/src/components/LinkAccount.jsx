import React, { useState } from 'react';
import axios from 'axios';
import { User as UserIcon, Lock, Link as LinkIcon } from 'lucide-react';

const LinkAccount = ({ localJwt, onLinked, onCancel }) => {
  const [externalJwt, setExternalJwt] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const apiBase = import.meta.env.VITE_API_BASE_URL || '/api/lbs';
      await axios.post(`${apiBase}/auth/link/confirm`, {}, {
        headers: {
          'Authorization': `Bearer ${localJwt}`,
          'X-EXTERNAL-JWT': externalJwt
        }
      });
      onLinked();
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to link external system');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-[100]">
      <div className="glass-card p-10 w-[450px] flex flex-col gap-8 shadow-2xl border-white/10">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-purple-500/20 flex items-center justify-center text-purple-400">
            <LinkIcon size={32} />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-white">Link External System</h2>
            <p className="text-slate-400 text-sm mt-2">
              Connect your account to an External Identity Provider.
            </p>
          </div>
        </div>

        {error && (
          <div className="p-4 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-xl flex items-center gap-3">
            <div className="w-1.5 h-1.5 rounded-full bg-red-500" />
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-widest pl-1">External Identity Token (JWT)</label>
            <div className="relative">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
              <input
                required
                className="w-full pl-12 bg-white/5 border-white/10 hover:border-white/20 transition-all text-white h-12 rounded-xl"
                placeholder="Paste External JWT here"
                value={externalJwt}
                onChange={(e) => setExternalJwt(e.target.value)}
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="primary w-full h-12 rounded-xl font-bold flex items-center justify-center gap-2 mt-2"
          >
            {isLoading ? (
              <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            ) : (
              'Link Identity'
            )}
          </button>
        </form>

        <div className="flex flex-col gap-4 text-center">
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-slate-500 hover:text-white underline"
          >
            Cancel Linking
          </button>
          <p className="text-[10px] text-slate-500">
            You will only need to do this once per External System identity.
          </p>
        </div>
      </div>
    </div>
  );
};

export default LinkAccount;
