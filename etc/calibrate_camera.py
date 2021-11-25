#!/usr/bin/env python

import cv2
import numpy as np
import matplotlib.pyplot as plt

import json
from json import JSONEncoder

import glob
import random
import sys
import io

aruco_dict = cv2.aruco.Dictionary_get(cv2.aruco.DICT_6X6_250)
# Note: Pattern generated using the following link
# https://calib.io/pages/camera-calibration-pattern-generator
board = cv2.aruco.CharucoBoard_create(25, 18, 18 * 0.001, 14 * 0.001, aruco_dict)

imboard = board.draw((1000, 2000))

cv2.imshow('board', imboard)

class NumpyArrayEncoder(JSONEncoder):
    def default(self, obj):
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        return JSONEncoder.default(self, obj)


def read_chessboards(frames):
    """
    Charuco base pose estimation.
    """
    all_corners = []
    all_ids = []
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 100, 0.00001)
    
    for frame in frames:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        corners, ids, rejectedImgPoints = cv2.aruco.detectMarkers(gray, aruco_dict)

        if len(corners) > 0:
            for corner in corners:
                cv2.cornerSubPix(gray, corner,
                                 winSize = (3,3),
                                 zeroZone = (-1,-1),
                                 criteria = criteria)

            ret, c_corners, c_ids = cv2.aruco.interpolateCornersCharuco(corners, ids, gray, board)
            # ret is the number of detected corners
            if ret > 0:
                all_corners.append(c_corners)
                all_ids.append(c_ids)
        else:
            print('Failed!')

    imsize = gray.shape
    return all_corners, all_ids, imsize

HIGH_VALUE = 10000
WIDTH = 1920
HEIGHT = 1080

def capture_camera(dev_num=0, num=1, mirror=False, size=None):
    frames = []

    cap = cv2.VideoCapture(dev_num)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, WIDTH)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, HEIGHT)

    while True:
        ret, frame = cap.read()

        if mirror is True:
            frame = cv2.flip(frame, 1)

        if size is not None and len(size) == 2:
            frame = cv2.resize(frame, size)

        # My config applies floating layout for windows named 'Java'
        cv2.imshow('Java', frame)

        k = cv2.waitKey(1)
        if k == 27:  # Esc
            break
        elif k == 10 or k == 32:  # Enter or Space
            frames.append(frame)
            print('Frame captured!')
            if len(frames) == num:
                break

    return frames


def draw_axis(frame, camera_matrix, dist_coeff, board, verbose=True):
    corners, ids, rejected_points = cv2.aruco.detectMarkers(frame, aruco_dict)
    if corners is None or ids is None:
        #print("no corners detected")
        return None
    if len(corners) != len(ids) or len(corners) == 0:
       # print("no corners detected")
        return None

    try:
        ret, c_corners, c_ids = cv2.aruco.interpolateCornersCharuco(corners,
                                                                    ids,
                                                                    frame,
                                                                    board)
        ret, p_rvec, p_tvec = cv2.aruco.estimatePoseCharucoBoard(c_corners,
                                                                c_ids,
                                                                board,
                                                                camera_matrix,
                                                                dist_coeff, np.empty(1), np.empty(1))
        cv2.aruco.drawDetectedCornersCharuco(frame, c_corners, c_ids)
        cv2.aruco.drawDetectedMarkers(frame, corners, ids)
        cv2.aruco.drawDetectedMarkers(frame, rejected_points, borderColor=(100, 0, 240))

        if p_rvec is None or p_tvec is None:
            print("no vectors!")
            return None
        if np.isnan(p_rvec).any() or np.isnan(p_tvec).any():
            print("some bad vectors!")
            return None
        cv2.aruco.drawAxis(frame,
                        camera_matrix,
                        dist_coeff,
                        p_rvec,
                        p_tvec,
                        0.1)
        #cv2.aruco.drawDetectedCornersCharuco(frame, c_corners, c_ids)
        #cv2.aruco.drawDetectedMarkers(frame, corners, ids)
        #cv2.aruco.drawDetectedMarkers(frame, rejected_points, borderColor=(100, 0, 240))
    except Exception as e:
        print("error!!")
        print(e)
        return None

    if verbose:
        print('Translation : {0}'.format(p_tvec))
        print('Rotation    : {0}'.format(p_rvec))
        print('Distance from camera: {0} m'.format(np.linalg.norm(p_tvec)))

    return frame



def undistort():
    f = open('camera.json')

    data = json.load(f)
    cap = cv2.VideoCapture(4)
    
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, WIDTH)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, HEIGHT)

    camera_matrix = np.array(data["camera_matrix"])
    dist_coeff = np.array(data["dist_coeff"])

    scaled_camera_matrix, roi = cv2.getOptimalNewCameraMatrix(
        camera_matrix, dist_coeff, (WIDTH, HEIGHT), 1, (WIDTH, HEIGHT)
    )

    while True:
        ret, frame = cap.read()
        
        distorted_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        undistorted_frame = cv2.undistort(
            distorted_frame, np.array(data["camera_matrix"]), np.array(data["dist_coeff"]), None, scaled_camera_matrix,
        )

        roi_x, roi_y, roi_w, roi_h = roi

        cropped_frame = undistorted_frame[roi_y : roi_y + roi_h, roi_x : roi_x + roi_w]
        cv2.imshow("distorted %s" % (distorted_frame.shape,), distorted_frame)
        cv2.imshow("undistorted %s" % (undistorted_frame.shape,), undistorted_frame)

        cv2.imshow("cropped %s" % (cropped_frame.shape,), cropped_frame)

        cv2.waitKey(10)



def main():
    undistort();
    return

    video_dev = int(sys.argv[1])
    frames = capture_camera(video_dev, 200)
    if len(frames) == 0:
        print('No frame captured')
        sys.exit(1)
    all_corners, all_ids, imsize = read_chessboards(frames)
    all_corners = [x for x in all_corners if len(x) >= 4]
    all_ids = [x for x in all_ids if len(x) >= 4]
    
    cameraMatrixInit = np.array([[ 1000.,    0., imsize[0]/2.],
                                 [    0., 1000., imsize[1]/2.],
                                 [    0.,    0.,           1.]])

    distCoeffsInit = np.zeros((5,1))
    flags = (cv2.CALIB_USE_INTRINSIC_GUESS + cv2.CALIB_RATIONAL_MODEL + cv2.CALIB_FIX_ASPECT_RATIO)

    criteria=(cv2.TERM_CRITERIA_EPS & cv2.TERM_CRITERIA_COUNT, 10000, 1e-9)

    (ret, camera_matrix, dist_coeff, rvec, tvec, stdDeviationsIntrinsics, stdDeviationsExtrinsics,
     perViewErrors) = cv2.aruco.calibrateCameraCharucoExtended(
        charucoCorners=all_corners, 
        charucoIds=all_ids, 
        board=board, 
        imageSize=imsize, 
        cameraMatrix=cameraMatrixInit, 
        distCoeffs=distCoeffsInit, 
        flags=flags, 
        criteria=criteria
    )

    print('> ret')
    print(ret)
    #camera_matrix = [[1.13373737e+03, 0.00000000e+00, 9.55059555e+02],[0.00000000e+00, 1.13767199e+03, 5.58583493e+02],[0.00000000e+00, 0.00000000e+00, 1.00000000e+00]]
    #dist_coeff= [[ 1.90519003e-01, -4.55223529e-01,  1.00693090e-03,  2.40030487e-04, 2.59034788e-01]]


    print('> Camera matrix')
    print(camera_matrix)
    print('> Distortion coefficients')
    print(dist_coeff)

    with io.open("camera.json", "w", encoding="utf8") as f:
        f.write(json.dumps({ "camera_matrix": camera_matrix, "dist_coeff": dist_coeff, "ret": ret}, cls=NumpyArrayEncoder))

    # Real-time axis drawing
    cap = cv2.VideoCapture(video_dev)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, WIDTH)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, HEIGHT)


    while True:
        ret, frame = cap.read()
        k = cv2.waitKey(1)
        if k == 27:  # Esc
            break
        axis_frame = draw_axis(frame, camera_matrix, dist_coeff, board, True)
        if axis_frame is not None:
            cv2.imshow('Java', axis_frame)
        else:
            #print("no axis frame!")
            cv2.imshow('Java', frame)


if __name__ == '__main__':
    main()
