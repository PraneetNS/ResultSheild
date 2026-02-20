#!/usr/bin/env python3
"""
Database seeding script for ResultShield
Generates sample student data and results
"""

import asyncio
import random
import hashlib
import json
from datetime import datetime, timedelta
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import text

# Database URL
import os
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql+asyncpg://resultshield:resultshield123@postgres-primary:5432/resultshield")
# Convert to asyncpg if it's the standard postgresql scheme
if DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)

# Sample data
DEPARTMENTS = ["Computer Science", "Electronics", "Mechanical", "Civil", "Electrical"]
BATCHES = ["2020", "2021", "2022", "2023", "2024"]
GRADES = ["A+", "A", "B+", "B", "C+", "C", "D", "F"]
GRADE_POINTS = {"A+": 10, "A": 9, "B+": 8, "B": 7, "C+": 6, "C": 5, "D": 4, "F": 0}

SUBJECTS = {
    1: [
        {"code": "CS101", "name": "Programming Fundamentals", "credits": 4},
        {"code": "MA101", "name": "Mathematics I", "credits": 4},
        {"code": "PH101", "name": "Physics", "credits": 3},
        {"code": "EN101", "name": "English", "credits": 3},
    ],
    2: [
        {"code": "CS201", "name": "Data Structures", "credits": 4},
        {"code": "MA201", "name": "Mathematics II", "credits": 4},
        {"code": "CS202", "name": "Digital Logic", "credits": 3},
        {"code": "EN201", "name": "Technical Writing", "credits": 2},
    ],
}


async def seed_database(num_students=10000):
    """Seed database with sample data"""
    
    engine = create_async_engine(DATABASE_URL, echo=False)
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    
    print(f"🌱 Seeding database with {num_students} students...")
    
    async with async_session() as session:
        # Generate students
        students = []
        for i in range(1, num_students + 1):
            dept = random.choice(DEPARTMENTS)
            batch = random.choice(BATCHES)
            roll_number = f"{batch}{dept[:2].upper()}{str(i).zfill(4)}"
            
            student_data = {
                "roll_number": roll_number,
                "name": f"Student {i}",
                "email": f"student{i}@university.edu",
                "department": dept,
                "batch": batch,
            }
            
            students.append(student_data)
            
            # Insert student
            await session.execute(
                text("""
                INSERT INTO students (roll_number, name, email, department, batch)
                VALUES (:roll_number, :name, :email, :department, :batch)
                ON CONFLICT (roll_number) DO NOTHING
                """),
                student_data
            )
            
            # Generate results for 2 semesters
            for semester in [1, 2]:
                subjects = SUBJECTS.get(semester, SUBJECTS[1])
                subject_results = []
                total_credits = 0
                total_grade_points = 0
                
                for subject in subjects:
                    grade = random.choices(
                        GRADES,
                        weights=[15, 25, 20, 15, 10, 8, 5, 2],  # Weighted distribution
                        k=1
                    )[0]
                    
                    subject_results.append({
                        "code": subject["code"],
                        "name": subject["name"],
                        "credits": subject["credits"],
                        "grade": grade,
                        "grade_points": GRADE_POINTS[grade]
                    })
                    
                    total_credits += subject["credits"]
                    total_grade_points += GRADE_POINTS[grade] * subject["credits"]
                
                sgpa = total_grade_points / total_credits if total_credits > 0 else 0
                cgpa = sgpa  # Simplified for demo
                
                result_data = {
                    "roll_number": roll_number,
                    "semester": semester,
                    "cgpa": round(cgpa, 2),
                    "sgpa": round(sgpa, 2),
                    "total_credits": total_credits,
                    "subjects": json.dumps(subject_results),
                    "status": "PASS" if sgpa >= 5.0 else "FAIL",
                    "published_at": datetime.now() - timedelta(days=random.randint(1, 30))
                }
                
                await session.execute(
                    text("""
                    INSERT INTO results (roll_number, semester, cgpa, sgpa, total_credits, subjects, status, published_at)
                    VALUES (:roll_number, :semester, :cgpa, :sgpa, :total_credits, :subjects, :status, :published_at)
                    ON CONFLICT DO NOTHING
                    """),
                    result_data
                )
            
            # Create result snapshot (precomputed JSON)
            snapshot_data = {
                "roll_number": roll_number,
                "student_name": student_data["name"],
                "department": dept,
                "batch": batch,
                "overall_cgpa": round(random.uniform(6.0, 9.5), 2),
                "total_semesters": 2,
                "semesters": []
            }
            
            # Calculate checksum
            checksum = hashlib.sha256(
                json.dumps(snapshot_data, sort_keys=True).encode()
            ).hexdigest()
            
            await session.execute(
                text("""
                INSERT INTO result_snapshots (roll_number, snapshot_data, checksum, is_active)
                VALUES (:roll_number, :snapshot_data, :checksum, :is_active)
                ON CONFLICT (roll_number) DO UPDATE SET
                    snapshot_data = :snapshot_data,
                    checksum = :checksum,
                    updated_at = CURRENT_TIMESTAMP
                """),
                {
                    "roll_number": roll_number,
                    "snapshot_data": json.dumps(snapshot_data),
                    "checksum": checksum,
                    "is_active": True
                }
            )
            
            if i % 1000 == 0:
                await session.commit()
                print(f"  ✓ Inserted {i}/{num_students} students")
        
        await session.commit()
        print(f"✅ Successfully seeded {num_students} students with results!")
    
    await engine.dispose()


if __name__ == "__main__":
    import sys
    
    num_students = int(sys.argv[1]) if len(sys.argv) > 1 else 10000
    asyncio.run(seed_database(num_students))
