import React, { useMemo } from 'react';
import { Clock, Lock } from 'lucide-react';

const LBSTimeline = ({ startDate, weekData, onTaskClick }) => {
    // Generate 7 days from start date
    const days = useMemo(() => {
        const d = [];
        const start = explicitDate(startDate);
        for (let i = 0; i < 7; i++) {
            const current = new Date(start);
            current.setDate(start.getDate() + i);
            d.push(current);
        }
        return d;
    }, [startDate]);

    // Hours 0-24
    const hours = Array.from({ length: 24 }, (_, i) => i);

    // Group tasks by date string (YYYY-MM-DD)
    const tasksByDate = useMemo(() => {
        const map = {};
        // Initialize map
        days.forEach(d => {
            map[fmtDate(d)] = [];
        });

        if (weekData) {
            weekData.forEach(daySchedule => {
                if (map[daySchedule.date]) {
                    map[daySchedule.date] = daySchedule.tasks || [];
                }
            });
        }
        return map;
    }, [days, weekData]);

    function explicitDate(d) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    function fmtDate(d) {
        // Use local time YYYY-MM-DD
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function getTaskStyle(task) {
        // Default to a 1-hour block if no time
        let top = 0;
        let height = 60; // 60px per hour

        if (task.start_time) {
            const [h, m] = task.start_time.split(':').map(Number);
            top = (h * 60) + m;
        }

        if (task.end_time && task.start_time) {
            const [sh, sm] = task.start_time.split(':').map(Number);
            const [eh, em] = task.end_time.split(':').map(Number);
            const startMins = (sh * 60) + sm;
            const endMins = (eh * 60) + em;
            let duration = endMins - startMins;
            if (duration < 30) duration = 30; // Min height
            height = duration;
        }

        return {
            top: `${top}px`,
            height: `${height}px`,
            position: 'absolute',
            width: '94%',
            left: '3%'
        };
    }

    function getLevelColor(load) {
        // Just a simple mapping, assuming load is roughly 0-10
        if (load > 8) return '#ef4444'; // Red
        if (load > 5) return '#f59e0b'; // Amber
        return '#3b82f6'; // Blue
    }

    return (
        <div className="flex flex-col h-full min-h-[600px] flex-grow overflow-hidden glass-card border border-white/5 rounded-xl">
            {/* Header Row */}
            <div className="flex border-b border-white/10 shrink-0">
                <div className="w-16 shrink-0 border-r border-white/10 p-2 text-center text-xs text-slate-500">
                    GMT+9
                </div>
                {days.map(day => (
                    <div key={day.toISOString()} className="flex-1 p-2 text-center border-r border-white/10 last:border-0">
                        <div className="text-xs text-slate-500 uppercase font-bold">{day.toLocaleDateString('en-US', { weekday: 'short' })}</div>
                        <div className={`text-xl font-bold ${isToday(day) ? 'text-blue-400' : 'text-white'}`}>
                            {day.getDate()}
                        </div>
                    </div>
                ))}
            </div>

            {/* Scrollable Grid */}
            <div className="flex-grow overflow-y-auto relative custom-scrollbar">
                <div className="flex relative min-h-[1440px]"> {/* 24 * 60px = 1440 */}
                    {/* Time Column */}
                    <div className="w-16 shrink-0 border-r border-white/5 bg-black/20 z-10">
                        {hours.map(h => (
                            <div key={h} className="h-[60px] border-b border-white/5 text-[10px] text-slate-600 p-1 text-right pr-2 relative">
                                <span className="-top-2 relative">{h}:00</span>
                            </div>
                        ))}
                    </div>

                    {/* Day Columns */}
                    {days.map(day => {
                        const dateStr = fmtDate(day);
                        const tasks = tasksByDate[dateStr] || [];
                        const timedTasks = tasks.filter(t => t.start_time);
                        const allDayTasks = tasks.filter(t => !t.start_time);

                        return (
                            <div key={dateStr} className="flex-1 border-r border-white/5 relative last:border-0 group">
                                {/* Hour Lines */}
                                {hours.map(h => (
                                    <div key={h} className="h-[60px] border-b border-white/5" />
                                ))}

                                {/* Tasks */}
                                {timedTasks.map(task => (
                                    <div
                                        key={task.task_id}
                                        onClick={(e) => { e.stopPropagation(); onTaskClick(task, dateStr); }}
                                        style={getTaskStyle(task)}
                                        className="rounded-lg p-2 text-xs border border-white/10 hover:z-50 hover:scale-[1.02] cursor-pointer shadow-lg transition-all overflow-hidden flex flex-col justify-start"
                                    >
                                        <div className="absolute inset-0 opacity-10" style={{ backgroundColor: getLevelColor(task.load) }} />
                                        <div className="absolute left-0 top-0 bottom-0 w-1" style={{ backgroundColor: getLevelColor(task.load) }} />
                                        <div className="font-bold truncate relative pl-2 flex items-center gap-1">
                                            {task.task_name}
                                            {task.is_locked && <Lock size={10} className="text-amber-500" />}
                                        </div>
                                        <div className="text-[10px] opacity-70 truncate relative pl-2 flex items-center gap-1">
                                            <Clock size={10} /> {task.start_time.slice(0, 5)} - {task.end_time?.slice(0, 5)}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        );
                    })}

                    {/* Current Time Indicator (if current week) */}
                    {/* Simplified: not checking if today is in view, logic can be added later */}
                </div>
            </div>
        </div>
    );
};

function isToday(date) {
    const today = new Date();
    return date.getDate() === today.getDate() &&
        date.getMonth() === today.getMonth() &&
        date.getFullYear() === today.getFullYear();
}

export default LBSTimeline;
