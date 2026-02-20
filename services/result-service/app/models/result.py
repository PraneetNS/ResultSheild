from sqlalchemy import Column, String, Integer, Float, JSON, DateTime, Index, Boolean
from sqlalchemy.sql import func
from app.core.database import Base


class Student(Base):
    """Student model"""
    __tablename__ = "students"
    
    id = Column(Integer, primary_key=True, index=True)
    roll_number = Column(String(50), unique=True, index=True, nullable=False)
    name = Column(String(200), nullable=False)
    email = Column(String(200), unique=True, index=True)
    department = Column(String(100))
    batch = Column(String(20))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    __table_args__ = (
        Index('idx_student_dept_batch', 'department', 'batch'),
    )


class Result(Base):
    """Result model"""
    __tablename__ = "results"
    
    id = Column(Integer, primary_key=True, index=True)
    roll_number = Column(String(50), index=True, nullable=False)
    semester = Column(Integer, nullable=False)
    cgpa = Column(Float)
    sgpa = Column(Float)
    total_credits = Column(Integer)
    subjects = Column(JSON)  # Store subjects as JSON
    status = Column(String(20), default="PASS")  # PASS, FAIL, WITHHELD
    remarks = Column(String(500))
    published_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    __table_args__ = (
        Index('idx_result_roll_semester', 'roll_number', 'semester'),
    )


class ResultSnapshot(Base):
    """Precomputed result snapshots for fast retrieval"""
    __tablename__ = "result_snapshots"
    
    id = Column(Integer, primary_key=True, index=True)
    roll_number = Column(String(50), unique=True, index=True, nullable=False)
    snapshot_data = Column(JSON, nullable=False)  # Complete result as JSON blob
    checksum = Column(String(64))  # For integrity verification
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    __table_args__ = (
        Index('idx_snapshot_active', 'is_active'),
    )


class AccessLog(Base):
    """Access log for audit trail"""
    __tablename__ = "access_logs"
    
    id = Column(Integer, primary_key=True, index=True)
    roll_number = Column(String(50), index=True)
    ip_address = Column(String(50))
    user_agent = Column(String(500))
    request_id = Column(String(100), index=True)
    response_time_ms = Column(Integer)
    cache_hit = Column(Boolean, default=False)
    accessed_at = Column(DateTime(timezone=True), server_default=func.now())
    
    __table_args__ = (
        Index('idx_access_log_time', 'accessed_at'),
    )
