#!/bin/bash
# Ollama Installation and LLaVA Setup Script for OpenHands
# This script installs Ollama and pulls the LLaVA vision model

set -e

echo "=========================================="
echo "OpenHands Local Vision Setup"
echo "=========================================="
echo ""

# Detect OS
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="linux"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "win32" ]]; then
    OS="windows"
else
    echo "⚠️  Unsupported operating system: $OSTYPE"
    echo "Please install Ollama manually from: https://ollama.com/download"
    exit 1
fi

echo "Detected OS: $OS"
echo ""

# Check if Ollama is already installed
if command -v ollama &> /dev/null; then
    echo "✅ Ollama is already installed"
    ollama --version
else
    echo "📦 Installing Ollama..."
    
    if [[ "$OS" == "linux" ]]; then
        # Linux installation
        curl -fsSL https://ollama.com/install.sh | sh
    elif [[ "$OS" == "macos" ]]; then
        # macOS installation
        if command -v brew &> /dev/null; then
            brew install ollama
        else
            echo "⚠️  Homebrew not found. Installing Ollama via official installer..."
            curl -fsSL https://ollama.com/install.sh | sh
        fi
    elif [[ "$OS" == "windows" ]]; then
        echo "⚠️  Windows detected. Please download and install Ollama manually from:"
        echo "   https://ollama.com/download/windows"
        echo ""
        echo "After installation, re-run this script to setup the LLaVA model."
        exit 0
    fi
    
    echo "✅ Ollama installed successfully"
fi

echo ""
echo "🚀 Starting Ollama service..."

# Start Ollama service (background)
if [[ "$OS" == "linux" ]] || [[ "$OS" == "macos" ]]; then
    if ! pgrep -x "ollama" > /dev/null; then
        ollama serve &
        OLLAMA_PID=$!
        echo "   Ollama service started (PID: $OLLAMA_PID)"
        sleep 3
    else
        echo "   Ollama service is already running"
    fi
fi

echo ""
echo "🤖 Pulling LLaVA vision model (this may take a few minutes)..."
echo "   LLaVA is a multimodal model that can analyze images and generate descriptions"
echo ""

# Pull LLaVA model
ollama pull llava

echo ""
echo "✅ LLaVA model pulled successfully"
echo ""

# Verify installation
echo "🔍 Verifying installation..."
if curl -s http://localhost:11434/api/tags | grep -q "llava"; then
    echo "✅ LLaVA is ready to use!"
    echo ""
    echo "=========================================="
    echo "Setup Complete!"
    echo "=========================================="
    echo ""
    echo "The local vision service is now configured to:"
    echo "  • Run on: http://localhost:11434"
    echo "  • Use model: llava"
    echo "  • Automatically analyze images before sending to LLM"
    echo ""
    echo "You can test it by uploading an image in the OpenHands chat interface."
    echo ""
    echo "To manually start Ollama later, run: ollama serve"
    echo "To see available models: ollama list"
    echo ""
else
    echo "⚠️  Warning: Could not verify LLaVA installation"
    echo "Please check if Ollama is running: ollama serve"
    exit 1
fi
