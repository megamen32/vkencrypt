"""Генератор одного 32-байтного (256-битного) ключа в hex.

Использование:
    python gen_key.py

Скопируйте вывод в bot/.env как значение PRE_SHARED_KEY_K1, K2, и т.д.
Или используй этот ключ в userscript'е через «➕ Добавить пользовательский ключ».
"""
from Crypto.Random import get_random_bytes
import binascii

if __name__ == "__main__":
    print(binascii.hexlify(get_random_bytes(32)).decode())
