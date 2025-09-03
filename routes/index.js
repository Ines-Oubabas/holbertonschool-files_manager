// routes/index.js
import { Router } from 'express';
import AppController from '../controllers/AppController.js';
import UsersController from '../controllers/UsersController.js';
import AuthController from '../controllers/AuthController.js';
import FilesController from '../controllers/FilesController.js';

const router = Router();

// Task 2
router.get('/status', AppController.getStatus);
router.get('/stats', AppController.getStats);

// Task 3
router.post('/users', UsersController.postNew);

// Task 4
router.get('/connect', AuthController.getConnect);
router.get('/disconnect', AuthController.getDisconnect);
router.get('/users/me', UsersController.getMe);

// Task 5
router.post('/files', FilesController.postUpload);

// Task 6
router.get('/files/:id', FilesController.getShow);
router.get('/files', FilesController.getIndex);

// Task 7
router.put('/files/:id/publish', FilesController.putPublish);
router.put('/files/:id/unpublish', FilesController.putUnpublish);

// Task 8
router.get('/files/:id/data', FilesController.getFile);

export default router;
