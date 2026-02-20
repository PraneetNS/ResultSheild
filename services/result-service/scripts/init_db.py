import asyncio
import os
import sys

# Add the current directory to sys.path so we can import 'app'
sys.path.append(os.getcwd())

from app.core.database import init_db
from app.models.result import Student, Result, ResultSnapshot, AccessLog

async def main():
    print("🚀 Initializing database tables...")
    await init_db()
    print("✅ Database initialized successfully!")

if __name__ == "__main__":
    asyncio.run(main())
