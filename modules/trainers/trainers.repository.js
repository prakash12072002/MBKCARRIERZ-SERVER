const { Types } = require("mongoose");
const { Trainer, Attendance } = require("../../models");

const buildTrainerDirectoryMatchStage = ({ searchRegex, cityRegex, cityId }) => {
  const stages = [];

  if (cityRegex || cityId) {
    const cityFilters = [];
    if (cityId) {
      cityFilters.push({ cityId: new Types.ObjectId(cityId) });
    }
    if (cityRegex) {
      cityFilters.push(
        { city: cityRegex },
        { "user.city": cityRegex },
      );
    }
    if (cityFilters.length > 0) {
      stages.push({ $match: { $or: cityFilters } });
    }
  }

  if (searchRegex) {
    stages.push({
      $match: {
        $or: [
          { trainerId: searchRegex },
          { firstName: searchRegex },
          { lastName: searchRegex },
          { email: searchRegex },
          { mobile: searchRegex },
          { phone: searchRegex },
          { city: searchRegex },
          { specialization: searchRegex },
          { "user.name": searchRegex },
          { "user.firstName": searchRegex },
          { "user.lastName": searchRegex },
          { "user.email": searchRegex },
          { "user.phoneNumber": searchRegex },
          { "user.city": searchRegex },
        ],
      },
    });
  }

  return stages;
};

const findTrainerDirectoryPage = async ({
  searchRegex = null,
  cityRegex = null,
  cityId = null,
  sortStage = { createdAt: -1, _id: -1 },
  skip = 0,
  limit = 50,
}) => {
  const queryStages = buildTrainerDirectoryMatchStage({
    searchRegex,
    cityRegex,
    cityId,
  });

  const pipeline = [
    {
      $lookup: {
        from: "users",
        localField: "userId",
        foreignField: "_id",
        as: "user",
      },
    },
    { $unwind: "$user" },
    {
      $match: {
        "user.role": { $regex: /^trainer$/i },
      },
    },
    ...queryStages,
    {
      $addFields: {
        userSortName: {
          $toLower: {
            $trim: {
              input: { $ifNull: ["$user.name", ""] },
            },
          },
        },
      },
    },
    { $sort: sortStage },
    {
      $facet: {
        data: [
          { $skip: Math.max(0, skip) },
          { $limit: Math.max(1, limit) },
          {
            $project: {
              _id: 1,
              trainerId: 1,
              email: 1,
              firstName: 1,
              lastName: 1,
              mobile: 1,
              phone: 1,
              city: 1,
              cityId: 1,
              specialization: 1,
              experience: 1,
              documents: 1,
              profilePicture: 1,
              status: 1,
              verificationStatus: 1,
              documentStatus: 1,
              registrationStatus: 1,
              registrationStep: 1,
              createdAt: 1,
              updatedAt: 1,
              userId: {
                _id: "$user._id",
                name: "$user.name",
                firstName: "$user.firstName",
                lastName: "$user.lastName",
                email: "$user.email",
                phoneNumber: "$user.phoneNumber",
                city: "$user.city",
                specialization: "$user.specialization",
                experience: "$user.experience",
                isActive: "$user.isActive",
                role: "$user.role",
                createdAt: "$user.createdAt",
              },
            },
          },
        ],
        total: [{ $count: "count" }],
      },
    },
  ];

  const [result] = await Trainer.aggregate(pipeline);
  const data = Array.isArray(result?.data) ? result.data : [];
  const total = Number(result?.total?.[0]?.count || 0);
  return { data, total };
};

const getTrainerAttendanceSummary = async (trainerIds = []) => {
  if (!Array.isArray(trainerIds) || trainerIds.length === 0) {
    return {
      completedDaysByTrainerId: new Map(),
      pendingDaysByTrainerId: new Map(),
    };
  }

  const normalizedIds = trainerIds
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => new Types.ObjectId(value));

  if (normalizedIds.length === 0) {
    return {
      completedDaysByTrainerId: new Map(),
      pendingDaysByTrainerId: new Map(),
    };
  }

  const summary = await Attendance.aggregate([
    {
      $match: {
        trainerId: { $in: normalizedIds },
      },
    },
    {
      $group: {
        _id: "$trainerId",
        completedDaysCount: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $ne: ["$completedAt", null] },
                  {
                    $and: [
                      { $eq: ["$verificationStatus", "approved"] },
                      {
                        $or: [
                          { $eq: ["$attendanceStatus", "PRESENT"] },
                          { $eq: ["$status", "Present"] },
                        ],
                      },
                    ],
                  },
                ],
              },
              1,
              0,
            ],
          },
        },
        pendingDaysCount: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ["$verificationStatus", "pending"] },
                  { $eq: ["$status", "Pending"] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);

  const completedDaysByTrainerId = new Map();
  const pendingDaysByTrainerId = new Map();

  summary.forEach((entry) => {
    const id = String(entry?._id || "").trim();
    if (!id) return;
    completedDaysByTrainerId.set(id, Number(entry?.completedDaysCount || 0));
    pendingDaysByTrainerId.set(id, Number(entry?.pendingDaysCount || 0));
  });

  return {
    completedDaysByTrainerId,
    pendingDaysByTrainerId,
  };
};

module.exports = {
  findTrainerDirectoryPage,
  getTrainerAttendanceSummary,
};

