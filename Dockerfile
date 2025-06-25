# Use official Node.js LTS image
FROM node:18-alpine

# Set working directory in container
WORKDIR /app

# Copy package files first for caching dependencies
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy your JS source code
COPY . .

# Expose port if your app runs on one (optional)
# EXPOSE 3000

# Command to run your app
CMD ["node", "index.js"]
