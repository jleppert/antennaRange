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

// ISR variables
volatile boolean limitReached = false;
volatile boolean limitDirection = LIMIT_MAX;
volatile boolean limitMaxReached = false;
volatile boolean limitMinReached = false;

boolean hasHomed = false;
boolean isHoming = false;
boolean isBusy = true;

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

StaticJsonDocument<128> status;
void sendStatus(String message) {
  status.clear();
  
  status["message"] = message;

  if(Serial) {
    serializeJson(status, Serial);
    Serial.println();
    Serial.flush();

    sendCurrentState();
  }
}

unsigned long lastStateUpdateTime;
unsigned long stateUpdateInterval = 1000;
void sendStateUpdate() {
  if((millis() - lastStateUpdateTime) > stateUpdateInterval) {
    sendCurrentState();
    lastStateUpdateTime = millis();
  }
}

void minLimitReached() {
  limitReached = true;
  limitDirection = LIMIT_MIN;
  
  limitMinReached = true;
}

volatile long maxXAxisPosition = 0;
void maxLimitReached() {
  limitReached = true;
  limitDirection = LIMIT_MAX;
   
  limitMaxReached = true;
}

void doHome() {
  if(!isHoming) {
    sendStatus("Homing in progress");
    delay(1000);
  }

	isHoming = true;

	if(limitReached == true) {
		if(limitDirection == LIMIT_MIN) {
      stepperX.setCurrentPosition(0);
      axisXEncoder.write(0);
			stepperX.setSpeed(MIN_SPEED * -1);
      sendStatus("Min limit reached");
		} else {
      maxXAxisPosition = axisXEncoder.read(); 
			stepperX.setSpeed(MIN_SPEED);
      sendStatus("Max limit reached");
		}

		limitReached = false;
	}

	if(limitMinReached && limitMaxReached) {
		hasHomed = true;
		isHoming = false;
    
    sendStatus("Homing complete");
	} else {
    stepperX.runSpeed();
	}
}


long margin = 2000;

boolean movingToHome = false;
boolean atHomePosition = false;
void setHomePosition() {
  if(movingToHome == false && atHomePosition == false) {
    movingToHome = true;
    sendStatus("Moving to home position");
    stepperX.setMaxSpeed(MIN_SPEED * 10);
    stepperX.move(abs(stepperX.currentPosition()));
  }
  
  long axisXPosition = axisXEncoder.read();

  if(axisXPosition > margin) {
    stepperX.run();
    sendStateUpdate();
  } else if ((axisXPosition < margin)) {
    stepperX.stop();
    stepperX.runToPosition();
 
    stepperX.setSpeed(200);

    while(axisXPosition != 0) {
      
      axisXPosition = axisXEncoder.read();

      if(axisXPosition > 0) {
        stepperX.setSpeed(200);
      } else {
        stepperX.setSpeed(200 * -1);
      }

      stepperX.runSpeed();

      sendStateUpdate();

      if(axisXPosition == 0) {
        movingToHome = false;
        atHomePosition = true;
        stepperX.setCurrentPosition(0);
        axisXEncoder.write(0);
        isBusy = false;
        sendStatus("Arrived at home position");
        break;
      }
    }
  }
}


// rail is in negative steps
boolean hasMovedToPosition = false;
long currentSetPosition = 0;
void moveToPosition() {
  long axisXPosition = axisXEncoder.read();

  if((currentSetPosition < 0) || (currentSetPosition > maxXAxisPosition)) {
    sendStatus("Invalid set position");
    return;
  }

  sendStatus("Moving to position: " + String(currentSetPosition));
  
  while(axisXPosition != currentSetPosition) {

    
    if(abs(axisXPosition - currentSetPosition) > margin) {
      if(axisXPosition > currentSetPosition) {
        stepperX.setSpeed(MIN_SPEED);
      } else {
        stepperX.setSpeed(MIN_SPEED * -1);
      }

      stepperX.runSpeed();
      sendStateUpdate();
    } else {
      stepperX.stop();
      stepperX.runToPosition();

      while(axisXPosition != currentSetPosition) {
        if(axisXPosition > currentSetPosition) {
          stepperX.setSpeed(200);
        } else {
          stepperX.setSpeed(200 * -1);
        }

        stepperX.runSpeed();
        axisXPosition = axisXEncoder.read();
        sendStateUpdate();
      }
    }
    axisXPosition = axisXEncoder.read();
  }

  hasMovedToPosition = true;
  sendStatus("Arrived at position: " + String(axisXPosition));
}

StaticJsonDocument<512> state;
void sendCurrentState() {
  state.clear();
  
  state["message"] = "state";
  state["isBusy"] = isBusy;
  state["hasHomed"] = hasHomed;
  state["isHoming"] = isHoming;
  state["atHomePosition"] = atHomePosition;
  state["limitMinReached"] = limitMinReached;
  state["limitMaxReached"] = limitMaxReached;
  state["hasMovedToPosition"] = hasMovedToPosition;
  state["movingToHome"] = movingToHome;
  state["currentSetPosition"] = currentSetPosition;
  state["currentPositionInEncoderSteps"] = axisXEncoder.read();
  state["currentPositionInStepperSteps"] = stepperX.currentPosition();
  state["maxPositionInEncoderSteps"] = maxXAxisPosition;
  state["maxStepperSpeedInStepperSteps"] = stepperX.maxSpeed();
  state["stepperSpeedInStepperSteps"] = stepperX.speed();

  if(Serial) {
     serializeJson(state, Serial);
     Serial.println();
     Serial.flush();
  }
}

StaticJsonDocument<200> hostCommand;
void loop() {
	if(!hasHomed) {
		doHome();
	} else {
    while(!atHomePosition) setHomePosition();
    if(Serial.available() > 0) {
      while(true) {
        String commandJSON = Serial.readStringUntil('\n');

        if(commandJSON.length() == 0) continue;
        hostCommand.clear();
        DeserializationError error = deserializeJson(hostCommand, commandJSON);

        if (error) {
          sendStatus("deserializeJson() failed: " + String(error.f_str()));
          continue;
        }

        const char* command = hostCommand["command"];
        
        if(strcmp(command, "home") == 0) {
          movingToHome = false;
          atHomePosition = false;
          isBusy = true;
          sendCurrentState();
          while(!atHomePosition) setHomePosition();
          isBusy = false;
          sendCurrentState();
        } else if(strcmp(command, "move") == 0) {
          hasMovedToPosition = false;
          currentSetPosition = hostCommand["position"];
          isBusy = true;
          sendCurrentState();
          while(!hasMovedToPosition) moveToPosition();
          isBusy = false;
          sendCurrentState();
        } else if(strcmp(command, "init") == 0) {
          isBusy = true;
          sendCurrentState();
          
          Serial.flush();
          Serial.end();
          wdt_enable( WDTO_1S);
        } else if(strcmp(command, "stop") == 0) {
          isBusy = true;
          sendCurrentState();
          
          stepperX.stop();
          stepperX.runToPosition(); 

          isBusy = false;
          sendCurrentState();
        } else if(strcmp(command, "state") == 0) {
          sendCurrentState();
        } else {
          sendStatus("Unknown command: " + String(command));
        }
      }
    }
	}
}   
