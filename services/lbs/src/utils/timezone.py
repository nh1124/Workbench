from datetime import datetime, date, time, timezone as datetime_timezone
from typing import Tuple, Optional
import logging

logger = logging.getLogger(__name__)

try:
    from zoneinfo import ZoneInfo
except ImportError:
    # Python < 3.9 fallback
    import pytz
    
    class ZoneInfo:
        def __new__(cls, key):
            try:
                return pytz.timezone(key)
            except pytz.UnknownTimeZoneError:
                raise ValueError("Unknown timezone")

def get_tz_info(tz_name: str):
    if not tz_name:
        return datetime_timezone.utc
    try:
        return ZoneInfo(tz_name)
    except Exception as e:
        logger.warning(f"Invalid timezone requested: {tz_name}. Falling back to UTC.")
        return datetime_timezone.utc

def get_local_today(tz_name: str = "UTC") -> date:
    tz = get_tz_info(tz_name)
    return datetime.now(tz).date()

def shift_task_time(target_date: date, target_time: Optional[time], from_tz: str, to_tz: str) -> Tuple[date, Optional[time]]:
    if not target_time:
        return target_date, None
    if from_tz == to_tz:
        return target_date, target_time
        
    tz_from = get_tz_info(from_tz)
    tz_to = get_tz_info(to_tz)
    
    dt_from = datetime.combine(target_date, target_time).replace(tzinfo=tz_from)
    dt_to = dt_from.astimezone(tz_to)
    
    return dt_to.date(), dt_to.time()
