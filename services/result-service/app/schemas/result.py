from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
from datetime import datetime


class SubjectResult(BaseModel):
    """Subject result schema"""
    code: str
    name: str
    credits: int
    grade: str
    grade_points: float


class SemesterResult(BaseModel):
    """Semester result schema"""
    semester: int
    sgpa: float
    cgpa: float
    total_credits: int
    subjects: List[Dict[str, Any]]
    status: str
    remarks: Optional[str] = None


class ResultResponse(BaseModel):
    """Basic result response"""
    roll_number: str
    student_name: str
    department: str
    batch: str
    overall_cgpa: float


class ResultDetailResponse(ResultResponse):
    """Detailed result response with semesters"""
    total_semesters: int
    semesters: List[Dict[str, Any]]
    metadata: Optional[Dict[str, Any]] = None


class ResultCreateRequest(BaseModel):
    """Request to create result"""
    roll_number: str
    semester: int
    subjects: List[Dict[str, Any]]
    
    class Config:
        json_schema_extra = {
            "example": {
                "roll_number": "2024CS001",
                "semester": 1,
                "subjects": [
                    {
                        "code": "CS101",
                        "name": "Programming Fundamentals",
                        "credits": 4,
                        "grade": "A",
                        "grade_points": 9.0
                    }
                ]
            }
        }
