import React, { useState, useEffect } from 'react';
import {
  LayoutDashboard,
  ListTodo,
  Settings,
  AlertTriangle,
  Plus,
  Calendar,
  Activity,
  History,
  User as UserIcon,
  Key,
  Coffee
} from 'lucide-react';
import axios from 'axios';
import Dashboard from './components/Dashboard';
import TaskManager from './components/TaskManager';
import LBSCalendar from './components/LBSCalendar';
import ExecutionManager from './components/ExecutionManager';
import ConditionManager from './components/ConditionManager';
import LinkAccount from './components/LinkAccount';
import APIKeyManager from './components/APIKeyManager';

const SidebarItem = ({ icon: Icon, label, active, onClick }) => (
  <div
    onClick={onClick}
    className={`flex items-center gap-4 p-4 cursor-pointer transition-all ${active ? 'bg-white/10 text-white rounded-xl' : 'text-slate-400 hover:text-white hover:bg-white/5 rounded-xl'
      }`}
  >
    <Icon size={20} />
    <span className="font-medium">{label}</span>
  </div>
);

function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [apiKey, setApiKey] = useState(''); // Only used as a fallback if no JWT
  const [jwt, setJwt] = useState(localStorage.getItem('lbs_jwt') || '');
  const [isAuthOpen, setIsAuthOpen] = useState(!jwt);
  const [isRegisterOpen, setIsRegisterOpen] = useState(false);
  const [isLinkingOpen, setIsLinkingOpen] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(!!jwt);

  // Auth & Registration Form State
  const [loginData, setLoginData] = useState({ username_or_email: '', password: '' });
  const [regData, setRegData] = useState({ name: '', email: '', password: '' });
  const [authError, setAuthError] = useState('');
  const [regError, setRegError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);

  useEffect(() => {
    // We no longer persistent the API key in localStorage for UI use
  }, [apiKey]);

  useEffect(() => {
    localStorage.setItem('lbs_jwt', jwt);
    if (jwt) {
      checkIdentity();
    }
  }, [jwt]);

  const checkIdentity = async () => {
    try {
      setIsCheckingAuth(true);
      const apiBase = import.meta.env.VITE_API_BASE_URL || '/api/lbs';
      const resp = await axios.get(`${apiBase}/auth/me`, {
        headers: { 'Authorization': `Bearer ${jwt}` }
      });
      // LBS returns local identity info
      setUnlinkedIdentity(null);
    } catch (err) {
      if (err.response?.status === 401) {
        // Token expired or invalid
        setJwt('');
        setIsAuthOpen(true);
      }
    } finally {
      setIsCheckingAuth(false);
    }
  };

  const handleProvision = async (rotate = false) => {
    try {
      const apiBase = import.meta.env.VITE_API_BASE_URL || '/api/lbs';
      const resp = await axios.post(`${apiBase}/auth/api-keys/provision`, { rotate }, {
        headers: { 'Authorization': `Bearer ${jwt}` }
      });
      if (resp.data.api_key) {
        alert(`Successfully provisioned! Your API key is: ${resp.data.api_key}\n\nPlease save it securely now.`);
      } else if (resp.data.already_exists) {
        if (window.confirm("A key already exists for this client. Do you want to rotate it? (Old key will be revoked)")) {
          handleProvision(true);
        }
      }
    } catch (err) {
      alert(err.response?.data?.detail || 'Provisioning failed');
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setIsLoggingIn(true);
    setAuthError('');
    try {
      const apiBase = import.meta.env.VITE_API_BASE_URL || '/api/lbs';
      const resp = await axios.post(`${apiBase}/auth/login`, loginData);
      setJwt(resp.data.access_token);
      setIsAuthOpen(false);
      setLoginData({ username_or_email: '', password: '' });
    } catch (err) {
      setAuthError(err.response?.data?.detail || "Login failed");
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setIsRegistering(true);
    setRegError('');
    try {
      await axios.post(`${import.meta.env.VITE_API_BASE_URL || '/api/lbs'}/users/`, regData);
      setIsRegisterOpen(false);
      setIsAuthOpen(true);
      alert("Registration successful! You can now log in.");
    } catch (err) {
      setRegError(err.response?.data?.detail || err.message);
    } finally {
      setIsRegistering(false);
    }
  };

  return (
    <div className="flex h-screen bg-[#0a0a0c]">
      {/* Sidebar */}
      <div className="w-64 border-r border-white/5 p-6 flex flex-col gap-8">
        <div className="flex items-center gap-3 px-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center font-bold text-white">L</div>
          <h1 className="text-xl font-bold gradient-text">LBS Control</h1>
        </div>

        <nav className="flex flex-col gap-2 flex-grow">
          <SidebarItem
            icon={LayoutDashboard}
            label="Dashboard"
            active={activeTab === 'dashboard'}
            onClick={() => setActiveTab('dashboard')}
          />
          <SidebarItem
            icon={ListTodo}
            label="Inventory"
            active={activeTab === 'tasks'}
            onClick={() => setActiveTab('tasks')}
          />
          <SidebarItem
            icon={Activity}
            label="Execution"
            active={activeTab === 'execution'}
            onClick={() => setActiveTab('execution')}
          />
          <SidebarItem
            icon={Calendar}
            label="Calendar"
            active={activeTab === 'calendar'}
            onClick={() => setActiveTab('calendar')}
          />
          <SidebarItem
            icon={Coffee}
            label="Condition"
            active={activeTab === 'condition'}
            onClick={() => setActiveTab('condition')}
          />
          <SidebarItem
            icon={Settings}
            label="Settings"
            active={activeTab === 'settings'}
            onClick={() => setActiveTab('settings')}
          />
        </nav>

        <div
          className="p-4 glass-card flex flex-col gap-2 cursor-pointer hover:bg-white/5"
          onClick={() => { setJwt(''); setIsAuthOpen(true); }}
        >
          <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Local Identity</div>
          <div className="flex items-center gap-2 text-xs text-slate-300">
            <UserIcon size={12} />
            <span className="truncate">{jwt ? 'Authenticated' : 'Sign In Required'}</span>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-grow overflow-y-auto p-10">
        {isCheckingAuth ? (
          <div className="flex items-center justify-center h-full text-slate-500 animate-pulse">Verifying Identity...</div>
        ) : (
          <>
            {activeTab === 'dashboard' && <Dashboard token={jwt} apiKey={apiKey} />}
            {activeTab === 'tasks' && <TaskManager token={jwt} apiKey={apiKey} />}
            {activeTab === 'execution' && <ExecutionManager token={jwt} apiKey={apiKey} />}
            {activeTab === 'calendar' && <LBSCalendar token={jwt} apiKey={apiKey} />}
            {activeTab === 'condition' && <ConditionManager token={jwt} />}
          </>
        )}
        {activeTab === 'settings' && (
          <div className="max-w-4xl mx-auto flex flex-col gap-12">
            <section>
              <h2 className="text-3xl font-bold mb-8">System Configuration</h2>
              <div className="glass-card p-8 flex flex-col gap-6">
                <div>
                  <label className="text-[10px] text-slate-500 uppercase tracking-widest font-bold mb-2 block">Microservice Endpoint</label>
                  <div className="bg-black/20 p-4 rounded-xl border border-white/5 font-mono text-sm text-blue-400">
                    {import.meta.env.VITE_API_BASE_URL || '/api/lbs'}
                  </div>
                </div>
                <div className="p-4 bg-purple-500/10 border border-purple-500/20 rounded-xl text-xs text-purple-200 leading-relaxed">
                  Default configurations (ALPHA, BETA, CAP) are automatically calculated and loaded from the backend per user session to optimize cognitive load balancing.
                </div>
              </div>
            </section>

            <section>
              <div className="flex justify-between items-center mb-8">
                <h2 className="text-3xl font-bold">External Integration</h2>
                <div className="flex gap-3">
                  <button
                    onClick={() => handleProvision()}
                    className="p-3 px-6 rounded-2xl bg-blue-500/10 border border-blue-500/20 text-blue-400 hover:bg-blue-500/20 transition-all font-bold flex items-center gap-2"
                  >
                    Provision External Client
                  </button>
                  <button
                    onClick={() => setIsLinkingOpen(true)}
                    className="p-3 px-6 rounded-2xl bg-purple-500/10 border border-purple-500/20 text-purple-400 hover:bg-purple-500/20 transition-all font-bold flex items-center gap-2"
                  >
                    Link External System
                  </button>
                </div>
              </div>
              <div className="glass-card p-8 text-slate-500 text-sm italic">
                Link an External IdP to allow cross-system automation, or manually provision a service key for external clients.
              </div>
            </section>

            <section>
              <APIKeyManager jwt={jwt} />
            </section>
          </div>
        )}
      </div>

      {/* Login Modal */}
      {isAuthOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="glass-card p-10 w-[450px] flex flex-col gap-8 shadow-2xl border-white/10">
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-blue-500/20 flex items-center justify-center text-blue-400 mx-auto mb-6">
                <LayoutDashboard size={32} />
              </div>
              <h2 className="text-2xl font-bold text-white uppercase tracking-wider">LBS Local Sign-In</h2>
              <p className="text-slate-400 text-sm mt-2">Enter your credentials to manage local load.</p>
            </div>

            {authError && <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-lg text-center font-bold font-mono">{authError}</div>}

            <form onSubmit={handleLogin} className="flex flex-col gap-5">
              <div className="flex flex-col gap-2">
                <label className="text-[10px] text-slate-500 uppercase tracking-widest font-bold pl-1">Username or Email</label>
                <input
                  required
                  className="w-full bg-white/5 border-white/10 hover:border-white/20 transition-all text-white h-12 rounded-xl"
                  placeholder="name@example.com"
                  value={loginData.username_or_email}
                  onChange={(e) => setLoginData({ ...loginData, username_or_email: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-[10px] text-slate-500 uppercase tracking-widest font-bold pl-1">Password</label>
                <input
                  required
                  type="password"
                  className="w-full bg-white/5 border-white/10 hover:border-white/20 transition-all text-white h-12 rounded-xl"
                  placeholder="••••••••"
                  value={loginData.password}
                  onChange={(e) => setLoginData({ ...loginData, password: e.target.value })}
                />
              </div>

              <button
                type="submit"
                disabled={isLoggingIn}
                className="primary w-full h-14 rounded-2xl font-bold text-lg mt-4 shadow-lg shadow-blue-500/10"
              >
                {isLoggingIn ? 'Authenticating...' : 'Sign In'}
              </button>
            </form>

            <div className="flex flex-col gap-4 text-center">
              <div className="h-[1px] bg-white/5 w-full"></div>
              <button
                className="text-slate-500 hover:text-white text-xs transition-all flex items-center justify-center gap-2"
                onClick={() => { setIsAuthOpen(false); setIsRegisterOpen(true); }}
              >
                Need an account? <span className="text-blue-400 font-bold underline">Create one now</span>
              </button>
              <p className="text-[10px] text-slate-600 uppercase tracking-widest">
                LBS Local Auth v2.0
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Link Account Modal */}
      {isLinkingOpen && (
        <LinkAccount
          localJwt={jwt}
          onLinked={() => {
            setIsLinkingOpen(false);
            alert("External System linked successfully!");
          }}
          onCancel={() => setIsLinkingOpen(false)}
        />
      )}

      {/* Register Modal */}
      {isRegisterOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
          <form onSubmit={handleRegister} className="glass-card p-8 w-[400px] flex flex-col gap-6">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-bold">Create LBS Account</h2>
              <button type="button" onClick={() => setIsRegisterOpen(false)} className="text-slate-500 hover:text-white">&times;</button>
            </div>

            {regError && <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-lg">{regError}</div>}

            <div className="flex flex-col gap-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Full Name</label>
                <input
                  required
                  className="w-full"
                  placeholder="e.g. John Doe"
                  value={regData.name}
                  onChange={(e) => setRegData({ ...regData, name: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Email Address</label>
                <input
                  required
                  type="email"
                  className="w-full"
                  placeholder="name@example.com"
                  value={regData.email}
                  onChange={(e) => setRegData({ ...regData, email: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Local Password</label>
                <input
                  required
                  type="password"
                  className="w-full"
                  placeholder="Create a local password"
                  value={regData.password}
                  onChange={(e) => setRegData({ ...regData, password: e.target.value })}
                />
              </div>
            </div>

            <button type="submit" disabled={isRegistering} className="primary w-full mt-2">
              {isRegistering ? 'Creating Account...' : 'Create Account'}
            </button>

            <div className="text-center">
              <button
                type="button"
                onClick={() => { setIsRegisterOpen(false); setIsAuthOpen(true); }}
                className="text-xs text-slate-500 hover:text-white"
              >
                Back to Login
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export default App;
