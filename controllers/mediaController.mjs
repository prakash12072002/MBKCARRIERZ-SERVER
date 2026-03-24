import cloudinary from 'cloudinary';
import multer from 'multer';
import { CloudinaryStorage } from 'multer-storage-cloudinary';

// Configuration (Should be in .env)
cloudinary.v2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'djayl5qxw',
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary.v2,
  params: async (req, file) => {
    let folder = 'chat-media';
    let resource_type = 'auto';

    if (file.mimetype.startsWith('image/')) folder = 'chat-images';
    else if (file.mimetype.startsWith('video/')) {
        folder = 'chat-videos';
        resource_type = 'video';
    }
    else if (file.mimetype.startsWith('audio/')) {
        folder = 'chat-audio';
        resource_type = 'video'; // Cloudinary treats audio as video for some operations
    }
    else folder = 'chat-docs';

    return {
      folder: folder,
      resource_type: resource_type,
      public_id: `${Date.now()}-${file.originalname.split('.')[0]}`,
    };
  },
});

export const parser = multer({ storage: storage });

export const uploadMedia = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Prepare response based on WhatsApp-style payload requirements
    const fileData = {
      type: req.body.type || (req.file.mimetype.startsWith('image/') ? 'image' : 
                               req.file.mimetype.startsWith('audio/') ? 'audio' :
                               req.file.mimetype.startsWith('video/') ? 'video' : 'file'),
      fileUrl: req.file.path, // Cloudinary secure_url
      name: req.file.originalname,
      size: req.file.size,
      mimeType: req.file.mimetype,
      duration: req.body.duration || null, // Provided by frontend for audio/video
    };

    res.status(200).json(fileData);
  } catch (error) {
    console.error('Upload Error:', error);
    res.status(500).json({ error: 'Failed to upload media' });
  }
};
