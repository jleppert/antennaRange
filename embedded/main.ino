#include <AccelStepper.h>
#include <Encoder.h>
#include <ArduinoJson.h>
#include <avr/wdt.h>

AccelStepper stepperX = AccelStepper(1, 5, 4);

Encoder axisXEncoder(3, 1);

const byte LIMIT_SWITCH_MIN_PIN = 7;
const byte LIMIT_SWITCH_MAX_PIN = 2;

#define MAX_SPEED 2000
#define MIN_SPEED 3000
#define ACCELERATION 2000

#define LIMIT_MIN false
#define LIMIT_MAX true

volatile boolean limitReached = false;
volatile boolean limitDirection = LIMIT_MAX;

volatile boolean hasHomed = false;
volatile boolean limitMaxReached = false;
volatile boolean limitMinReached = false;
volatile boolean isHoming = false;

void sendStatus(String message) {
  String jsonResponse;

  jsonResponse = "{\"status\": \"";
  jsonResponse += message;
  jsonResponse += "\"}";
  
  Serial.println(jsonResponse);
  Serial.flush();
}

void setup() {
  MCUSR = 0;
  Serial.begin(9600);
  
  while(!Serial){}
  delay(1000);

  sendStatus("Initializing Range...");
  
  stepperX.setMaxSpeed(MIN_SPEED * 10);
  stepperX.setAcceleration(ACCELERATION);

  pinMode(LIMIT_SWITCH_MIN_PIN, INPUT_PULLUP);
  pinMode(LIMIT_SWITCH_MAX_PIN, INPUT_PULLUP);

  // clear all interrupts
  EIFR = (1 << INTF1);
  
  delay(50);

  attachInterrupt(digitalPinToInterrupt(LIMIT_SWITCH_MIN_PIN), minLimitReached, FALLING); 
  attachInterrupt(digitalPinToInterrupt(LIMIT_SWITCH_MAX_PIN), maxLimitReached, FALLING);

  if(digitalRead(LIMIT_SWITCH_MIN_PIN) == LOW) {
    limitDirection = LIMIT_MIN;
    limitMinReached = true;
    limitReached = true;
    stepperX.setSpeed(MIN_SPEED);

    stepperX.setCurrentPosition(0);
    axisXEncoder.write(0);
  } else if(digitalRead(LIMIT_SWITCH_MAX_PIN) == LOW) {
    limitDirection = LIMIT_MAX;
    limitMaxReached = true;
    limitReached = true;
    stepperX.setSpeed(MIN_SPEED * -1);
  } else {
    stepperX.setSpeed(MIN_SPEED);
  }

  wdt_disable();
}

void minLimitReached() {
  limitReached = true;
  limitDirection = LIMIT_MIN;
  
  stepperX.setCurrentPosition(0);
  axisXEncoder.write(0);
  
  limitMinReached = true;
}

volatile long maxXAxisPosition = 0;
void maxLimitReached() {
  limitReached = true;
  limitDirection = LIMIT_MAX;
  
  maxXAxisPosition = axisXEncoder.read();  
  limitMaxReached = true;
}

unsigned long lastMillis;
long travelSteps;
long lastXEncoderValue = 0;
long pulsesPerStep = 0;
void doHome() {
  if(!isHoming) {
    sendStatus("Homing in progress");
    delay(1000);
  }
  
	isHoming = true;
	stepperX.runSpeed();
  
  if (millis() - lastMillis >= 1000UL) {
    lastMillis = millis();
    if(limitMinReached) {
      travelSteps += MIN_SPEED;
      long currentXAxisPosition = axisXEncoder.read();
      pulsesPerStep = abs(currentXAxisPosition - lastXEncoderValue) / MIN_SPEED;
      lastXEncoderValue = currentXAxisPosition; 
    }
  }

	if(limitReached == true) {
		if(limitDirection == LIMIT_MIN) {
      stepperX.setCurrentPosition(0);
			stepperX.setSpeed(MIN_SPEED * -1);
		} else {
			stepperX.setSpeed(MIN_SPEED);
		}

		limitReached = false;
	}

	if(limitMinReached && limitMaxReached) {
		hasHomed = true;
		isHoming = false;
   
    sendStatus("Homing complete");
    sendStatus("Max X Axis Position" + String(maxXAxisPosition));
	}
}

long ticksPerStep;
long margin = 2000;

boolean movingToHome = false;
boolean atHomePosition = false;
void setHomePosition() {
  if(movingToHome == false && atHomePosition == false) {
    sendStatus("Moving to home position");
    stepperX.setMaxSpeed(MIN_SPEED * 10);
    stepperX.move(abs(stepperX.currentPosition()));
    
    movingToHome = true;
  }
  
  long axisXPosition = axisXEncoder.read();

  if(axisXPosition > margin) {
    stepperX.run();
  } else if ((axisXPosition < margin)) {
    stepperX.stop();
    delay(1000);
    stepperX.setSpeed(200);

    while(axisXPosition != 0) {
      
      axisXPosition = axisXEncoder.read();

      if(axisXPosition > 0) {
        stepperX.setSpeed(200);
      } else {
        stepperX.setSpeed(200 * -1);
      }

      stepperX.runSpeed();

      if(axisXPosition == 0) {
        movingToHome = false;
        atHomePosition = true;
        stepperX.setCurrentPosition(0);
        axisXEncoder.write(0);
        sendStatus("Arrived at home position");
        break;
      }
    }
  }
}


// rail is in negative steps
boolean hasMovedToPosition = false;
void moveToPosition(long position) {
  long axisXPosition = axisXEncoder.read();

  if(position < 0) return;
  if(position == axisXPosition) return;
  if(position > maxXAxisPosition) return;

  sendStatus("Moving to position: " + String(position));
  sendStatus("Current position: " + String(axisXPosition));
  
  while(axisXPosition != position) {
    if(axisXPosition > position) {
      stepperX.setSpeed(MIN_SPEED);
    } else {
      stepperX.setSpeed(MIN_SPEED * -1);
    }

    stepperX.runSpeed();
    axisXPosition = axisXEncoder.read();
  }

  sendStatus("Arrived at position: " + String(axisXPosition));
  hasMovedToPosition = true;
}

StaticJsonDocument<200> doc;
void loop() {
	if(!hasHomed) {
		doHome();
	} else {
    while(!atHomePosition) setHomePosition();
    if(Serial.available() > 0) {
      while(true) {
        String commandJSON = Serial.readStringUntil('\n');

        if(commandJSON.length() == 0) continue;
        Serial.println(commandJSON);
        DeserializationError error = deserializeJson(doc, commandJSON);

        if (error) {
          sendStatus("deserializeJson() failed: " + String(error.f_str()));
          continue;
        }

        const char* command = doc["command"];
        
        if(strcmp(command, "home") == 0) {
          movingToHome = false;
          atHomePosition = false;
          while(!atHomePosition) setHomePosition();
        } else if(strcmp(command, "move") == 0) {
          hasMovedToPosition = false;
          long position = doc["position"];
          
          while(!hasMovedToPosition) moveToPosition(position);
        } else if(strcmp(command, "init") == 0) {
          Serial.flush();
          Serial.end();
          wdt_enable( WDTO_1S);
        } else if(strcmp(command, "stop") == 0) {
          stepperX.stop();
        } else {
          sendStatus("Unknown command: " + String(command));
        }
      }
    }
	}
}
