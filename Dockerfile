FROM node:18-alpine

# Install git and other dependencies
RUN apk add --no-cache git python3 make g++

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Copy app source
COPY . .

# Expose the port (if your app uses one, like 3000)
# EXPOSE 3000

# Run the bot
CMD ["npm", "start"]
