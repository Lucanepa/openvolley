#!/usr/bin/env python3
"""
PDF Form Field Selective Flattener
Flattens only fields matching a specific pattern (e.g., containing "_sub_")
"""

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, TextStringObject, DictionaryObject, ArrayObject
import sys
import shutil

def should_flatten(field_name, pattern):
    """Check if a field should be flattened based on pattern"""
    return pattern in field_name

def flatten_field_if_match(field_obj, pattern, parent_name=""):
    """
    Flatten a field if it matches the pattern, otherwise return as-is
    Returns list of (full_name, field_dict, should_replace) tuples
    """
    # Get the partial name of this field
    partial_name = str(field_obj.get("/T", ""))
    full_name = f"{parent_name}.{partial_name}" if parent_name else partial_name
    
    # Check if this field has widget children
    if "/Kids" in field_obj:
        kids = field_obj["/Kids"]
        
        # Check if the children are widget annotations
        has_widget_kids = False
        if len(kids) > 0:
            first_kid = kids[0].get_object()
            if "/Subtype" in first_kid and first_kid["/Subtype"] == "/Widget":
                has_widget_kids = True
        
        if has_widget_kids and should_flatten(full_name, pattern):
            # This field matches pattern and has widgets - flatten it!
            flattened = []
            
            for idx, kid in enumerate(kids):
                kid_obj = kid.get_object()
                
                # Create a new independent field for this widget
                new_field = DictionaryObject()
                
                # Copy all properties from parent except /Kids
                for key in field_obj.keys():
                    if key not in ["/Kids", "/T"]:
                        new_field[key] = field_obj[key]
                
                # Set the new name with suffix
                new_name = f"{full_name}#{idx}"
                new_field[NameObject("/T")] = TextStringObject(new_name)
                
                # Copy widget-specific properties from the kid
                for key in kid_obj.keys():
                    if key not in ["/Parent", "/T"]:
                        new_field[key] = kid_obj[key]
                
                flattened.append((new_name, new_field, True))
            
            return flattened
    
    # Don't flatten this field - return as-is
    return [(full_name, field_obj, False)]

def flatten_matching_fields(input_pdf, output_pdf, pattern="_sub_"):
    """
    Flatten only fields matching the pattern
    """
    reader = PdfReader(input_pdf)
    writer = PdfWriter()
    writer.append(reader)
    
    if "/AcroForm" not in writer._root_object:
        print("No form fields found!")
        return False
    
    acro_form = writer._root_object["/AcroForm"]
    if "/Fields" not in acro_form:
        print("No fields array found!")
        return False
    
    fields_array = acro_form["/Fields"]
    original_count = len(fields_array)
    
    print(f"\nOriginal top-level fields: {original_count}")
    print(f"Pattern to match: '{pattern}'")
    print("\nFlattening matching fields...\n")
    
    # Process each field
    new_fields_list = []
    flattened_count = 0
    total_new_fields = 0
    
    for idx in range(len(fields_array)):
        field_obj = fields_array[idx].get_object()
        field_name = str(field_obj.get("/T", f"Field{idx+1}"))
        
        result = flatten_field_if_match(field_obj, pattern)
        
        if len(result) > 1 or (len(result) == 1 and result[0][2]):
            # This field was flattened
            print(f"Position {idx + 1}: '{field_name}' → {len(result)} separate fields")
            for name, _, _ in result:
                print(f"  - {name}")
            flattened_count += 1
            total_new_fields += len(result)
            
            # Add the flattened fields
            for _, field_dict, _ in result:
                new_fields_list.append(writer._add_object(field_dict))
        else:
            # Keep the original field
            new_fields_list.append(fields_array[idx])
    
    if flattened_count > 0:
        # Replace the fields array
        new_fields_array = ArrayObject(new_fields_list)
        acro_form[NameObject("/Fields")] = new_fields_array
        
        # Write the result
        temp_pdf = output_pdf + ".tmp"
        with open(temp_pdf, "wb") as output_file:
            writer.write(output_file)
        shutil.move(temp_pdf, output_pdf)
        
        final_count = len(new_fields_list)
        
        print(f"\n{'='*60}")
        print(f"✓ Flattened {flattened_count} field(s) matching pattern '{pattern}'")
        print(f"✓ Original fields: {original_count}")
        print(f"✓ Final fields: {final_count} (added {final_count - original_count} new fields)")
        print(f"✓ File saved: {output_pdf}")
        print(f"{'='*60}")
        return True
    else:
        print(f"\n✗ No fields matching pattern '{pattern}' found to flatten")
        return False

def list_matching_fields(input_pdf, pattern="_sub_"):
    """List only fields matching the pattern"""
    reader = PdfReader(input_pdf)
    
    if "/Root" not in reader.trailer or "/AcroForm" not in reader.trailer["/Root"]:
        print("No form fields found in the PDF!")
        return
    
    acro_form = reader.trailer["/Root"]["/AcroForm"]
    if "/Fields" not in acro_form:
        print("No fields array found!")
        return
    
    fields_array = acro_form["/Fields"]
    
    print(f"\nTotal top-level fields: {len(fields_array)}")
    print(f"Pattern: '{pattern}'")
    print(f"\n{'Position':<10} {'Field Name':<60} {'Widgets':<10}")
    print("-" * 80)
    
    matching_count = 0
    
    for idx in range(len(fields_array)):
        field_obj = fields_array[idx].get_object()
        name = str(field_obj.get("/T", f"Field{idx+1}"))
        
        if pattern in name:
            matching_count += 1
            widgets = ""
            if "/Kids" in field_obj:
                kids = field_obj["/Kids"]
                if len(kids) > 0:
                    first_kid = kids[0].get_object()
                    if "/Subtype" in first_kid and first_kid["/Subtype"] == "/Widget":
                        widgets = f"{len(kids)}"
            
            print(f"{idx + 1:<10} {name:<60} {widgets:<10}")
    
    print(f"\nTotal matching fields: {matching_count}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage:")
        print("  Flatten fields matching pattern:")
        print("    python flatten_selective.py input.pdf [pattern]")
        print()
        print("  List matching fields:")
        print("    python flatten_selective.py input.pdf --list [pattern]")
        print()
        print("Examples:")
        print("  python flatten_selective.py form.pdf _sub_")
        print("  python flatten_selective.py form.pdf --list _sub_")
        print()
        print("Default pattern: '_sub_'")
        sys.exit(1)
    
    input_file = sys.argv[1]
    
    # Default pattern
    pattern = "_sub_"
    
    if len(sys.argv) >= 3 and sys.argv[2] == "--list":
        if len(sys.argv) >= 4:
            pattern = sys.argv[3]
        list_matching_fields(input_file, pattern)
    else:
        if len(sys.argv) >= 3:
            pattern = sys.argv[2]
        flatten_matching_fields(input_file, input_file, pattern)