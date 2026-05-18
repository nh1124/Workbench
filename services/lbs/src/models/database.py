from sqlalchemy import Column, String, Integer, Float, Boolean, Date, Time, DateTime, Text, ForeignKey, create_engine, Enum as SAEnum, UniqueConstraint
from sqlalchemy.orm import relationship, sessionmaker
from datetime import datetime, timezone
import enum
from .user import Base, User, APIKey
from .external_identity import ExternalIdentity
from ..config import settings

class TaskStatus(str, enum.Enum):
    TODO = "todo"
    DONE = "done"
    SKIPPED = "skipped"

class SystemConfig(Base):
    """User-specific LBS configuration"""
    __tablename__ = "system_config"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String, ForeignKey("users.user_id"), nullable=False)
    key = Column(String, nullable=False)
    value = Column(String, nullable=False)
    description = Column(Text)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

class Task(Base):
    """Master task definitions with user ownership"""
    __tablename__ = "tasks"
    
    task_id = Column(String, primary_key=True)
    user_id = Column(String, ForeignKey("users.user_id"), nullable=False, index=True)
    task_name = Column(String, nullable=False)
    context = Column(String, nullable=False)
    base_load_score = Column(Float, nullable=False)
    active = Column(Boolean, default=True)
    rule_type = Column(String, nullable=False)
    due_date = Column(Date, nullable=True)
    mon = Column(Boolean, default=False)
    tue = Column(Boolean, default=False)
    wed = Column(Boolean, default=False)
    thu = Column(Boolean, default=False)
    fri = Column(Boolean, default=False)
    sat = Column(Boolean, default=False)
    sun = Column(Boolean, default=False)
    interval_days = Column(Integer, nullable=True)
    anchor_date = Column(Date, nullable=True)
    month_day = Column(Integer, nullable=True)
    nth_in_month = Column(Integer, nullable=True)
    weekday_mon1 = Column(Integer, nullable=True)
    start_date = Column(Date, nullable=True)
    end_date = Column(Date, nullable=True)
    start_time = Column(Time, nullable=True)
    end_time = Column(Time, nullable=True)
    notes = Column(Text)
    external_sync_id = Column(String, nullable=True)
    timezone = Column(String, default='UTC')
    is_locked = Column(Boolean, default=False)  # Marker for external systems to prevent modifications
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

class TaskException(Base):
    """Exceptions to task rules"""
    __tablename__ = "task_exceptions"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String, ForeignKey("users.user_id"), nullable=False, index=True)
    task_id = Column(String, ForeignKey("tasks.task_id", ondelete="CASCADE"), nullable=False)
    target_date = Column(Date, nullable=False)
    exception_type = Column(String, nullable=False)  # SKIP, OVERRIDE_LOAD, FORCE_DO
    override_load_value = Column(Float, nullable=True)
    start_time = Column(Time, nullable=True)  # Override start time for this date
    end_time = Column(Time, nullable=True)    # Override end time for this date
    notes = Column(Text)
    is_locked = Column(Boolean, default=False)  # Lock this exception from modifications
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

class TaskExecution(Base):
    """History of task executions and their outcomes"""
    __tablename__ = "task_executions"
    
    id = Column(Integer, primary_key=True)
    user_id = Column(String, ForeignKey("users.user_id"), nullable=False, index=True)
    task_id = Column(String, ForeignKey("tasks.task_id", ondelete="CASCADE"), nullable=False, index=True)
    target_date = Column(Date, nullable=False, index=True)
    status = Column(SAEnum(TaskStatus, native_enum=False), default=TaskStatus.DONE) # e.g., "done", "skipped"
    progress = Column(Integer, default=100)
    actual_time = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    
    __table_args__ = (
        UniqueConstraint('user_id', 'task_id', 'target_date', name='uq_task_execution_user_date'),
    )

class LBSDailyCache(Base):
    """Expanded task cache"""
    __tablename__ = "lbs_daily_cache"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String, ForeignKey("users.user_id"), nullable=False, index=True)
    target_date = Column(Date, nullable=False, index=True)
    task_id = Column(String, ForeignKey("tasks.task_id", ondelete="CASCADE"), nullable=False)
    calculated_load = Column(Float, nullable=False)
    status = Column(SAEnum(TaskStatus, native_enum=False), default=TaskStatus.TODO)
    is_overflow = Column(Boolean, default=False)
    generated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    
    __table_args__ = (
        UniqueConstraint('user_id', 'task_id', 'target_date', name='_user_task_date_uc'),
    )

class DailyCondition(Base):
    """User-specific daily condition (fatigue, etc.)"""
    __tablename__ = "daily_conditions"
    
    user_id = Column(String, ForeignKey("users.user_id"), primary_key=True)
    target_date = Column(Date, primary_key=True)
    cognitive_fatigue = Column(Integer, default=0) # 0-5
    physical_fatigue = Column(Integer, default=0)  # 0-5
    note = Column(Text, nullable=True)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

# DB setup
# Handle SQLite specific arguments
engine_args = {}
if settings.DATABASE_URL.startswith("sqlite"):
    engine_args["connect_args"] = {"check_same_thread": False}

engine = create_engine(settings.DATABASE_URL, **engine_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
