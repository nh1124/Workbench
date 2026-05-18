from sqlalchemy import Column, String, DateTime, ForeignKey, UniqueConstraint, Index
from sqlalchemy.orm import relationship
import uuid
from datetime import datetime, timezone
from .user import Base

class ExternalIdentity(Base):
    __tablename__ = "external_identities"
    
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String, ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False)
    issuer = Column(String, nullable=False)
    subject = Column(String, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    
    user = relationship("User")

    __table_args__ = (
        UniqueConstraint('issuer', 'subject', name='_issuer_subject_uc'),
        Index('idx_issuer_subject', 'issuer', 'subject'),
    )
