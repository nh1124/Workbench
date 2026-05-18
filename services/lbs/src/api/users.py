from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
import uuid

from ..models.database import get_db, User, APIKey
from .schemas import UserCreate, UserResponse
from ..auth import require_local_user, Identity, get_password_hash

router = APIRouter(prefix="/users", tags=["Users"])

@router.post("/", response_model=UserResponse)
def create_user(user_in: UserCreate, db: Session = Depends(get_db)):
    db_user = db.query(User).filter(User.email == user_in.email).first()
    if db_user:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    new_user = User(
        email=user_in.email,
        name=user_in.name,
        password_hash=get_password_hash(user_in.password) if user_in.password else None,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    
    return new_user

@router.get("/me", response_model=UserResponse)
async def get_current_user_info(
    db: Session = Depends(get_db),
    identity: Identity = Depends(require_local_user)
):
    user = db.query(User).filter(User.user_id == identity.user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User record not found")
    
    return user
