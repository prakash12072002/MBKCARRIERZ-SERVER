-- Users Table
CREATE TABLE Users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL, -- 'SuperAdmin', 'CompanyAdmin', 'SPOCAdmin', 'Trainer', 'AccouNDAnt'
    isActive BOOLEAN DEFAULT TRUE,
    emailVerified BOOLEAN DEFAULT FALSE,
    verificationToken VARCHAR(255),
    createdAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Companies Table
CREATE TABLE Companies (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    adminName VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(20),
    plan VARCHAR(50), -- 'Basic', 'Premium', 'Enterprise'
    createdAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Courses Table
CREATE TABLE Courses (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    companyId INTEGER REFERENCES Companies(id) ON DELETE CASCADE,
    courseHead VARCHAR(255),
    createdAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Colleges Table
CREATE TABLE Colleges (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    companyId INTEGER REFERENCES Companies(id) ON DELETE CASCADE,
    city VARCHAR(100),
    zone VARCHAR(100), -- 'North', 'South', 'East', 'West'
    principalName VARCHAR(255),
    principalPhone VARCHAR(20),
    principalEmail VARCHAR(255),
    collegeSpoc VARCHAR(255),
    companySpoc VARCHAR(255),
    createdAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- CourseColleges (Many-to-Many)
CREATE TABLE CourseColleges (
    courseId INTEGER REFERENCES Courses(id) ON DELETE CASCADE,
    collegeId INTEGER REFERENCES Colleges(id) ON DELETE CASCADE,
    createdAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (courseId, collegeId)
);

-- Trainers Table
CREATE TABLE Trainers (
    id SERIAL PRIMARY KEY,
    userId INTEGER REFERENCES Users(id) ON DELETE CASCADE,
    phone VARCHAR(20),
    specialization VARCHAR(255),
    verificationStatus VARCHAR(50) DEFAULT 'Pending', -- 'Pending', 'Verified', 'Rejected'
    resumeUrl VARCHAR(255),
    panCardUrl VARCHAR(255),
    aadharCardUrl VARCHAR(255),
    createdAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- CollegeTrainers (Many-to-Many)
CREATE TABLE CollegeTrainers (
    collegeId INTEGER REFERENCES Colleges(id) ON DELETE CASCADE,
    trainerId INTEGER REFERENCES Trainers(id) ON DELETE CASCADE,
    createdAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (collegeId, trainerId)
);

-- Batches Table
CREATE TABLE Batches (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL, -- e.g., 'Batch A - 2023'
    companyId INTEGER REFERENCES Companies(id),
    courseId INTEGER REFERENCES Courses(id),
    collegeId INTEGER REFERENCES Colleges(id),
    startDate DATE,
    endDate DATE,
    status VARCHAR(50) DEFAULT 'Active', -- 'Active', 'Completed', 'Archived'
    createdAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Schedules Table (Days)
CREATE TABLE Schedules (
    id SERIAL PRIMARY KEY,
    batchId INTEGER REFERENCES Batches(id) ON DELETE SET NULL,
    dayNumber INTEGER NOT NULL, -- 1 to 12
    date DATE,
    startTime TIME,
    endTime TIME,
    topic VARCHAR(255),
    status VARCHAR(50) DEFAULT 'Pending', -- 'Pending', 'Completed', 'Cancelled'
    trainerId INTEGER REFERENCES Trainers(id),
    collegeId INTEGER REFERENCES Colleges(id),
    courseId INTEGER REFERENCES Courses(id),
    companyId INTEGER REFERENCES Companies(id),
    createdBy INTEGER REFERENCES Users(id),
    createdAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Attendance Table (Student Attendance)
CREATE TABLE Attendances (
    id SERIAL PRIMARY KEY,
    scheduleId INTEGER REFERENCES Schedules(id) ON DELETE CASCADE,
    trainerId INTEGER REFERENCES Trainers(id),
    collegeId INTEGER REFERENCES Colleges(id),
    date DATE NOT NULL,
    status VARCHAR(50) DEFAULT 'Present',
    studentCount INTEGER DEFAULT 0,
    photoUrl VARCHAR(255),
    locationLat DECIMAL(10, 8),
    locationLng DECIMAL(11, 8),
    verificationStatus VARCHAR(50) DEFAULT 'Pending', -- 'Pending', 'Approved', 'Rejected'
    verifiedBy INTEGER REFERENCES Users(id),
    verifiedAt TIMESTAMP WITH TIME ZONE,
    createdAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- TrainerAttendance Table (HR Attendance)
CREATE TABLE TrainerAttendances (
    id SERIAL PRIMARY KEY,
    trainerId INTEGER REFERENCES Trainers(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    status VARCHAR(50) DEFAULT 'Present', -- 'Present', 'Absent', 'Leave'
    checkInTime TIMESTAMP WITH TIME ZONE,
    checkOutTime TIMESTAMP WITH TIME ZONE,
    locationLat DECIMAL(10, 8),
    locationLng DECIMAL(11, 8),
    createdAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- FinancialRecords Table
CREATE TABLE FinancialRecords (
    id SERIAL PRIMARY KEY,
    trainerId INTEGER REFERENCES Trainers(id),
    type VARCHAR(50) NOT NULL, -- 'Credit', 'Debit'
    amount DECIMAL(10, 2) NOT NULL,
    description TEXT,
    date DATE DEFAULT CURRENT_DATE,
    createdAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Salaries Table
CREATE TABLE Salaries (
    id SERIAL PRIMARY KEY,
    trainerId INTEGER REFERENCES Trainers(id),
    month VARCHAR(20) NOT NULL, -- e.g., '2023-11'
    amount DECIMAL(10, 2) NOT NULL,
    status VARCHAR(50) DEFAULT 'Pending', -- 'Pending', 'Paid'
    generatedAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    paidAt TIMESTAMP WITH TIME ZONE,
    createdAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- TrainerDocuments Table
CREATE TABLE TrainerDocuments (
    id SERIAL PRIMARY KEY,
    trainerId INTEGER REFERENCES Trainers(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL, -- 'Resume', 'PanCard', 'Aadhar', 'Certificate'
    url VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'Pending', -- 'Pending', 'Verified', 'Rejected'
    verifiedBy INTEGER REFERENCES Users(id),
    rejectionReason TEXT,
    createdAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
